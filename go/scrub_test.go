package instatus

import (
	"reflect"
	"testing"
)

func TestSensitiveKeys(t *testing.T) {
	for _, key := range []string{"password", "passwd", "PASS", "client_secret", "accessToken", "api_key", "api.key", "apikey", "Authorization", "credentials", "sessionId", "Cookie", "csrf", "xsrf-token", "private_key", "signature"} {
		if !isSensitiveKey(key) {
			t.Errorf("%q should be sensitive", key)
		}
	}
	for _, key := range []string{"plan", "user", "region", "id"} {
		if isSensitiveKey(key) {
			t.Errorf("%q should not be sensitive", key)
		}
	}
}

func TestScrubTextFiltersCardNumbersThatPassLuhn(t *testing.T) {
	cases := map[string]string{
		"card 4111 1111 1111 1111 declined": "card [Filtered] declined",
		"card 4111-1111-1111-1111":          "card [Filtered]",
		"5500000000000004":                  Filtered,
		"order 4111111111111112":            "order 4111111111111112",
		"at 1700000000000":                  "at 1700000000000",
		"short 4111 1111":                   "short 4111 1111",
	}
	for input, want := range cases {
		if got := scrubText(input); got != want {
			t.Errorf("scrubText(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestScrubURL(t *testing.T) {
	cases := map[string]string{
		"https://user:pass@example.com/a?token=abc&page=2#access_token=xyz": "https://example.com/a?token=[Filtered]&page=2#access_token=[Filtered]",
		"https://example.com/pay?number=4111111111111111":                   "https://example.com/pay?number=[Filtered]",
		"https://example.com/?api%5Fkey=1":                                  "https://example.com/?api%5Fkey=[Filtered]",
		"https://example.com/plain?q=go":                                    "https://example.com/plain?q=go",
	}
	for input, want := range cases {
		if got := scrubURL(input); got != want {
			t.Errorf("scrubURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestScrubValueWalksMapsAndSlices(t *testing.T) {
	value := map[string]any{
		"name": "Ada",
		"request": map[string]any{
			"password": "hunter2",
			"url":      "https://a:b@example.com/?session=1",
			"items":    []any{map[string]string{"token": "t"}, "4111111111111111"},
		},
	}
	want := map[string]any{
		"name": "Ada",
		"request": map[string]any{
			"password": Filtered,
			"url":      "https://example.com/?session=[Filtered]",
			"items":    []any{map[string]any{"token": Filtered}, Filtered},
		},
	}
	if got := scrubValue("payload", value); !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

func TestScrubValueFiltersWholeValueUnderSensitiveKey(t *testing.T) {
	if got := scrubValue("auth", map[string]any{"user": "a"}); got != Filtered {
		t.Errorf("got %#v", got)
	}
}

type credentials struct {
	Login    string `json:"login"`
	Password string `json:"password"`
	internal string
}

func TestScrubValueUsesStructJSONForm(t *testing.T) {
	got := scrubValue("account", credentials{Login: "ada", Password: "hunter2", internal: "x"})
	want := map[string]any{"login": "ada", "password": Filtered}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v, want %#v", got, want)
	}
}

func TestScrubValueStopsAtDepthSix(t *testing.T) {
	var value any = "leaf"
	for range 8 {
		value = map[string]any{"next": value}
	}
	current := scrubValue("root", value)
	for depth := 0; depth < maxScrubDepth; depth++ {
		current = current.(map[string]any)["next"]
	}
	if current != truncated {
		t.Errorf("depth %d = %#v, want %q", maxScrubDepth, current, truncated)
	}
}

func TestScrubValueCutsCyclesButKeepsSharedValues(t *testing.T) {
	cyclic := map[string]any{"name": "loop"}
	cyclic["self"] = cyclic
	got := scrubValue("value", cyclic).(map[string]any)
	if got["self"] != circular {
		t.Errorf("self = %#v", got["self"])
	}

	address := map[string]any{"city": "Cairo"}
	shared := scrubValue("order", map[string]any{"billing": address, "shipping": address}).(map[string]any)
	if !reflect.DeepEqual(shared["billing"], shared["shipping"]) || shared["shipping"].(map[string]any)["city"] != "Cairo" {
		t.Errorf("shared value lost: %#v", shared)
	}
}

func TestScrubValueKeepsScalars(t *testing.T) {
	for _, value := range []any{3, 2.5, true, nil, []byte("raw")} {
		if got := scrubValue("value", value); !reflect.DeepEqual(got, value) {
			t.Errorf("scrubValue(%#v) = %#v", value, got)
		}
	}
}
