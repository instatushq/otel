package instatus

import (
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"regexp"
	"strings"
)

// Filtered replaces values the filters remove.
const Filtered = "[Filtered]"

const (
	maxScrubDepth = 6
	circular      = "[Circular]"
	truncated     = "[Truncated]"
	unreadable    = "[Unreadable]"
)

var (
	sensitiveKey   = regexp.MustCompile(`(?i)pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature`)
	cardNumber     = regexp.MustCompile(`\b\d(?:[ -]?\d){12,18}\b`)
	urlCredentials = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*://)[^/@?#]*@`)
	urlScheme      = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	urlParam       = regexp.MustCompile(`([?&#])([^=&#]+)=([^&#]*)`)
	urlKey         = regexp.MustCompile(`(?i)(^|[._-])url$`)
)

func isSensitiveKey(key string) bool {
	return sensitiveKey.MatchString(key)
}

// The Luhn check keeps timestamps and order numbers of card length.
func passesLuhn(digits string) bool {
	sum := 0
	for index := 0; index < len(digits); index++ {
		digit := int(digits[len(digits)-1-index] - '0')
		if index%2 == 1 {
			digit *= 2
		}
		if digit > 9 {
			digit -= 9
		}
		sum += digit
	}
	return sum%10 == 0
}

func onlyDigits(text string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, text)
}

func scrubText(text string) string {
	return cardNumber.ReplaceAllStringFunc(text, func(match string) string {
		if passesLuhn(onlyDigits(match)) {
			return Filtered
		}
		return match
	})
}

func decodeComponent(value string) string {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

// OAuth redirects put tokens in the hash as well as the query, and a card
// number can sit in any parameter, so URLs get the text filter too.
func scrubURL(raw string) string {
	withoutCredentials := urlCredentials.ReplaceAllString(raw, "$1")
	filtered := urlParam.ReplaceAllStringFunc(withoutCredentials, func(match string) string {
		parts := urlParam.FindStringSubmatch(match)
		if !isSensitiveKey(decodeComponent(parts[2])) {
			return match
		}
		return parts[1] + parts[2] + "=" + Filtered
	})
	return scrubText(filtered)
}

func scrubString(key, value string) string {
	if urlKey.MatchString(key) {
		return scrubURL(value)
	}
	return scrubText(value)
}

// scrubValue walks maps, slices and structs, since an extra or context value
// is serialized whole: {"request": {"password": …}} must lose the password too.
func scrubValue(key string, value any) any {
	return scrubNested(key, value, 0, map[uintptr]bool{})
}

func scrubNested(key string, value any, depth int, ancestors map[uintptr]bool) any {
	if isSensitiveKey(key) {
		return Filtered
	}
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		return scrubString(key, typed)
	case error:
		return scrubText(typed.Error())
	case fmt.Stringer:
		return scrubString(key, typed.String())
	}
	reflected := reflect.ValueOf(value)
	for reflected.Kind() == reflect.Pointer || reflected.Kind() == reflect.Interface {
		if reflected.IsNil() {
			return nil
		}
		reflected = reflected.Elem()
	}
	switch reflected.Kind() {
	case reflect.Map, reflect.Array:
	case reflect.Slice:
		if reflected.Type().Elem().Kind() == reflect.Uint8 {
			return value
		}
	case reflect.Struct:
		return scrubStruct(key, value, depth, ancestors)
	case reflect.String:
		return scrubString(key, reflected.String())
	default:
		return value
	}
	identity, tracked := identityOf(reflected)
	if tracked && ancestors[identity] {
		return circular
	}
	if depth >= maxScrubDepth {
		return truncated
	}
	if tracked {
		ancestors[identity] = true
		defer delete(ancestors, identity)
	}
	if reflected.Kind() == reflect.Map {
		return scrubMap(reflected, depth, ancestors)
	}
	items := make([]any, reflected.Len())
	for index := range items {
		items[index] = scrubNested("", readElement(reflected.Index(index)), depth+1, ancestors)
	}
	return items
}

// ancestors holds the maps and slices on the current path only, so a value
// used twice (billing and shipping address) is kept and only a cycle is cut.
func identityOf(value reflect.Value) (uintptr, bool) {
	switch value.Kind() {
	case reflect.Map:
		return value.Pointer(), !value.IsNil()
	case reflect.Slice:
		return value.Pointer(), value.Len() > 0
	}
	return 0, false
}

func readElement(value reflect.Value) any {
	if !value.CanInterface() {
		return unreadable
	}
	return value.Interface()
}

func scrubMap(value reflect.Value, depth int, ancestors map[uintptr]bool) any {
	scrubbed := make(map[string]any, value.Len())
	iterator := value.MapRange()
	for iterator.Next() {
		childKey := mapKeyString(iterator.Key())
		scrubbed[childKey] = scrubNested(childKey, readElement(iterator.Value()), depth+1, ancestors)
	}
	return scrubbed
}

func mapKeyString(key reflect.Value) string {
	if key.Kind() == reflect.String {
		return key.String()
	}
	encoded, err := json.Marshal(readElement(key))
	if err != nil {
		return unreadable
	}
	return strings.Trim(string(encoded), `"`)
}

// Structs go through their JSON form, so json tags name the keys the filters
// check and unexported fields stay out, as they would when serialized.
func scrubStruct(key string, value any, depth int, ancestors map[uintptr]bool) any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return unreadable
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return unreadable
	}
	return scrubNested(key, decoded, depth, ancestors)
}
