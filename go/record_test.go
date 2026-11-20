package instatus

import (
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
)

func attributeMap(record logRecord) map[string]any {
	values := map[string]any{}
	for _, field := range record.Attributes {
		switch field.Value.Type() {
		case attribute.STRING:
			values[string(field.Key)] = field.Value.AsString()
		case attribute.BOOL:
			values[string(field.Key)] = field.Value.AsBool()
		case attribute.INT64:
			values[string(field.Key)] = field.Value.AsInt64()
		case attribute.FLOAT64:
			values[string(field.Key)] = field.Value.AsFloat64()
		}
	}
	return values
}

func exceptionEvent() *Event {
	event := newEvent(LevelError)
	event.EventID = "0123456789abcdef0123456789abcdef"
	event.Timestamp = time.Unix(1700000000, 0)
	event.Exception = &Exception{
		Type:       "*fs.PathError",
		Value:      "open /etc/app.yaml: no such file or directory",
		Stacktrace: "goroutine 1 [running]:\nmain.main()\n\t/app/main.go:12 +0x1d\n",
		Handled:    true,
	}
	return event
}

func TestRecordForException(t *testing.T) {
	record := eventToRecord(exceptionEvent())
	if record.Body != "*fs.PathError: open /etc/app.yaml: no such file or directory" {
		t.Errorf("body = %q", record.Body)
	}
	if record.Severity != 17 || record.SeverityText != "ERROR" {
		t.Errorf("severity = %d %s", record.Severity, record.SeverityText)
	}
	if !record.Timestamp.Equal(time.Unix(1700000000, 0)) {
		t.Errorf("timestamp = %v", record.Timestamp)
	}
	got := attributeMap(record)
	want := map[string]any{
		"exception.type":       "*fs.PathError",
		"exception.message":    "open /etc/app.yaml: no such file or directory",
		"exception.stacktrace": "goroutine 1 [running]:\nmain.main()\n\t/app/main.go:12 +0x1d\n",
		"exception.handled":    true,
		"log.record.uid":       "0123456789abcdef0123456789abcdef",
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s = %#v, want %#v", key, got[key], value)
		}
	}
	if record.Attributes[0].Key != "exception.type" {
		t.Errorf("exception attributes must come first, got %s", record.Attributes[0].Key)
	}
}

func TestSeverityLevels(t *testing.T) {
	cases := map[Level]struct {
		number log.Severity
		text   string
	}{
		LevelFatal:   {21, "FATAL"},
		LevelError:   {17, "ERROR"},
		LevelWarning: {13, "WARN"},
		LevelInfo:    {9, "INFO"},
		"log":        {9, "INFO"},
		LevelDebug:   {5, "DEBUG"},
		"unknown":    {17, "ERROR"},
	}
	for level, want := range cases {
		record := eventToRecord(eventFromMessage("hello", level))
		if record.Severity != want.number || record.SeverityText != want.text {
			t.Errorf("%s = %d %s, want %d %s", level, record.Severity, record.SeverityText, want.number, want.text)
		}
	}
}

func TestErrorMessagesAreIssuesAndLowerLevelsArePlainLogs(t *testing.T) {
	issue := attributeMap(eventToRecord(eventFromMessage("Stripe webhook signature mismatch", LevelError)))
	if issue["exception.type"] != "Error" || issue["exception.message"] != "Stripe webhook signature mismatch" {
		t.Errorf("error message attributes = %#v", issue)
	}
	info := eventToRecord(eventFromMessage("deployed", LevelInfo))
	if _, ok := attributeMap(info)["exception.type"]; ok || info.Body != "deployed" {
		t.Errorf("info message = %#v", info)
	}
}

func TestMetadataAttributes(t *testing.T) {
	event := exceptionEvent()
	event.Tags = map[string]string{"plan": "pro", "exception.type": "spoofed", "instatus.site": "x"}
	event.Contexts = map[string]Context{"cart": {"items": 3, "token": "secret"}}
	event.Extra = map[string]any{"retry": 2, "payload": map[string]any{"password": "p", "ok": true}}
	event.User = &User{Email: "ada@example.com", Username: "ada", IPAddress: "10.0.0.1", Data: map[string]string{"team": "core"}}

	got := attributeMap(eventToRecord(event))
	want := map[string]any{
		"plan":           "pro",
		"exception.type": "*fs.PathError",
		"cart.items":     int64(3),
		"cart.token":     Filtered,
		"extra.retry":    int64(2),
		"extra.payload":  `{"ok":true,"password":"[Filtered]"}`,
		"enduser.id":     "ada@example.com",
		"user.email":     "ada@example.com",
		"user.name":      "ada",
		"user.ip":        "10.0.0.1",
		"user.team":      "core",
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s = %#v, want %#v", key, got[key], value)
		}
	}
	if _, ok := got["instatus.site"]; ok {
		t.Error("instatus. keys must be dropped")
	}
	if _, ok := got["user.id"]; ok {
		t.Error("empty user fields must be left out")
	}
}

func TestEndUserPrefersIDThenEmailThenUsername(t *testing.T) {
	cases := map[string]User{
		"7":     {ID: "7", Email: "a@b.c", Username: "a"},
		"a@b.c": {Email: "a@b.c", Username: "a"},
		"a":     {Username: "a"},
	}
	for want, user := range cases {
		event := eventFromMessage("x", LevelInfo)
		event.User = &user
		if got := attributeMap(eventToRecord(event))["enduser.id"]; got != want {
			t.Errorf("enduser.id = %#v, want %q", got, want)
		}
	}
}

func TestRecordFiltersAndCutsValues(t *testing.T) {
	event := exceptionEvent()
	event.Exception.Value = "charge 4111 1111 1111 1111 failed"
	event.Exception.Stacktrace = strings.Repeat("s", maxStackLength+10)
	event.Extra = map[string]any{"long": strings.Repeat("é", maxValueLength)}

	record := eventToRecord(event)
	got := attributeMap(record)
	if got["exception.message"] != "charge [Filtered] failed" || record.Body != "*fs.PathError: charge [Filtered] failed" {
		t.Errorf("card number kept: %q / %q", got["exception.message"], record.Body)
	}
	if length := len(got["exception.stacktrace"].(string)); length != maxStackLength {
		t.Errorf("stack length = %d", length)
	}
	long := got["extra.long"].(string)
	if len(long) > maxValueLength || !strings.HasSuffix(long, "é") {
		t.Errorf("value cut badly: %d bytes", len(long))
	}
}
