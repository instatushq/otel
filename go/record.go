package instatus

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
)

const (
	reservedPrefix = "instatus."
	maxValueLength = 8192
	maxStackLength = 32000
)

type severity struct {
	number log.Severity
	text   string
}

var severities = map[Level]severity{
	LevelFatal:   {log.SeverityFatal, "FATAL"},
	LevelError:   {log.SeverityError, "ERROR"},
	LevelWarning: {log.SeverityWarn, "WARN"},
	"log":        {log.SeverityInfo, "INFO"},
	LevelInfo:    {log.SeverityInfo, "INFO"},
	LevelDebug:   {log.SeverityDebug, "DEBUG"},
}

var userKeys = map[string]string{
	"username":   "name",
	"ip_address": "ip",
}

type logRecord struct {
	Timestamp    time.Time
	Severity     log.Severity
	SeverityText string
	Body         string
	Attributes   []attribute.KeyValue
}

func (r logRecord) attribute(key string) (attribute.Value, bool) {
	for _, field := range r.Attributes {
		if string(field.Key) == key {
			return field.Value, true
		}
	}
	return attribute.Value{}, false
}

type attributes struct {
	keys   []string
	values map[string]attribute.Value
}

func newAttributes() *attributes {
	return &attributes{values: map[string]attribute.Value{}}
}

func (a *attributes) set(key string, value attribute.Value) {
	if _, exists := a.values[key]; !exists {
		a.keys = append(a.keys, key)
	}
	a.values[key] = value
}

func (a *attributes) has(key string) bool {
	_, exists := a.values[key]
	return exists
}

func (a *attributes) put(key string, value any) {
	if strings.HasPrefix(key, reservedPrefix) {
		return
	}
	if converted, ok := toAttributeValue(scrubValue(key, value)); ok {
		a.set(key, converted)
	}
}

func (a *attributes) list() []attribute.KeyValue {
	list := make([]attribute.KeyValue, 0, len(a.keys))
	for _, key := range a.keys {
		list = append(list, attribute.KeyValue{Key: attribute.Key(key), Value: a.values[key]})
	}
	return list
}

func cut(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}

func stringify(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

func toAttributeValue(value any) (attribute.Value, bool) {
	if value == nil {
		return attribute.Value{}, false
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.String:
		text := cut(reflected.String(), maxValueLength)
		return attribute.StringValue(text), text != ""
	case reflect.Bool:
		return attribute.BoolValue(reflected.Bool()), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return attribute.Int64Value(reflected.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		if number := reflected.Uint(); number <= math.MaxInt64 {
			return attribute.Int64Value(int64(number)), true
		}
		return attribute.StringValue(fmt.Sprint(value)), true
	case reflect.Float32, reflect.Float64:
		return attribute.Float64Value(reflected.Float()), true
	}
	return attribute.StringValue(cut(stringify(value), maxValueLength)), true
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func endUserID(user *User) string {
	if user.ID != "" {
		return user.ID
	}
	if user.Email != "" {
		return user.Email
	}
	return user.Username
}

func putUser(target *attributes, user *User) {
	if user == nil || user.isZero() {
		return
	}
	if id := endUserID(user); id != "" {
		target.set("enduser.id", attribute.StringValue(cut(id, maxValueLength)))
	}
	fields := map[string]string{
		"id":         user.ID,
		"email":      user.Email,
		"username":   user.Username,
		"ip_address": user.IPAddress,
	}
	for key, value := range user.Data {
		if _, taken := fields[key]; !taken {
			fields[key] = value
		}
	}
	for _, key := range sortedKeys(fields) {
		name := key
		if renamed, ok := userKeys[key]; ok {
			name = renamed
		}
		target.put("user."+name, fields[key])
	}
}

func metadataOf(event *Event) *attributes {
	metadata := newAttributes()
	for _, key := range sortedKeys(event.Tags) {
		metadata.put(key, event.Tags[key])
	}
	for _, name := range sortedKeys(event.Contexts) {
		values := event.Contexts[name]
		for _, key := range sortedKeys(values) {
			metadata.put(name+"."+key, values[key])
		}
	}
	for _, key := range sortedKeys(event.Extra) {
		metadata.put("extra."+key, event.Extra[key])
	}
	putUser(metadata, event.User)
	return metadata
}

func severityOf(level Level) severity {
	if found, ok := severities[level]; ok {
		return found
	}
	return severities[LevelError]
}

func exceptionTypeOf(exception *Exception) string {
	if exception.Type == "" {
		return defaultErrorType
	}
	return exception.Type
}

func putException(target *attributes, event *Event, isError bool) {
	exception := event.Exception
	if exception == nil {
		if isError && event.Message != "" {
			target.set("exception.type", attribute.StringValue(defaultErrorType))
			target.set("exception.message", attribute.StringValue(cut(scrubText(event.Message), maxValueLength)))
		}
		return
	}
	target.set("exception.type", attribute.StringValue(exceptionTypeOf(exception)))
	target.set("exception.message", attribute.StringValue(cut(scrubText(exception.Value), maxValueLength)))
	if exception.Stacktrace != "" {
		target.set("exception.stacktrace", attribute.StringValue(cut(scrubText(exception.Stacktrace), maxStackLength)))
	}
	target.set("exception.handled", attribute.BoolValue(exception.Handled))
}

func bodyOf(event *Event) string {
	if event.Exception == nil {
		return scrubText(event.Message)
	}
	kind := exceptionTypeOf(event.Exception)
	message := scrubText(event.Exception.Value)
	if message == "" {
		return kind
	}
	return kind + ": " + message
}

// Tags, contexts and extras become log attributes, and errors follow the
// OpenTelemetry exception conventions so Instatus Errors groups them.
func eventToRecord(event *Event) logRecord {
	level := severityOf(event.Level)
	record := newAttributes()
	putException(record, event, level.number >= log.SeverityError)
	record.set("log.record.uid", attribute.StringValue(event.EventID))

	// The error's own fields come first and win: receivers cap attribute
	// counts, and metadata must never push the exception out.
	metadata := metadataOf(event)
	for _, key := range metadata.keys {
		if !record.has(key) {
			record.set(key, metadata.values[key])
		}
	}

	return logRecord{
		Timestamp:    event.Timestamp,
		Severity:     level.number,
		SeverityText: level.text,
		Body:         bodyOf(event),
		Attributes:   record.list(),
	}
}
