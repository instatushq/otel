package instatus_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	instatus "github.com/instatushq/otel/go"
	logspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracespb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	otlplogs "go.opentelemetry.io/proto/otlp/logs/v1"
	"google.golang.org/protobuf/proto"
)

type request struct {
	path    string
	headers http.Header
	body    []byte
}

type collector struct {
	mu       sync.Mutex
	requests []request
}

func (c *collector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	c.requests = append(c.requests, request{path: r.URL.Path, headers: r.Header.Clone(), body: body})
	c.mu.Unlock()
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(http.StatusOK)
}

func (c *collector) on(path string) []request {
	c.mu.Lock()
	defer c.mu.Unlock()
	var matched []request
	for _, received := range c.requests {
		if received.path == path {
			matched = append(matched, received)
		}
	}
	return matched
}

func (c *collector) logRecords(t *testing.T) []*otlplogs.LogRecord {
	t.Helper()
	var records []*otlplogs.LogRecord
	for _, received := range c.on("/v1/logs") {
		var export logspb.ExportLogsServiceRequest
		if err := proto.Unmarshal(received.body, &export); err != nil {
			t.Fatal(err)
		}
		for _, resource := range export.ResourceLogs {
			for _, scope := range resource.ScopeLogs {
				records = append(records, scope.LogRecords...)
			}
		}
	}
	return records
}

func attributesOf(values []*commonpb.KeyValue) map[string]*commonpb.AnyValue {
	found := map[string]*commonpb.AnyValue{}
	for _, value := range values {
		found[value.Key] = value.Value
	}
	return found
}

func recordWithBody(records []*otlplogs.LogRecord, prefix string) *otlplogs.LogRecord {
	for _, record := range records {
		if strings.HasPrefix(record.Body.GetStringValue(), prefix) {
			return record
		}
	}
	return nil
}

var (
	goroutineHeader = regexp.MustCompile(`(?m)^goroutine \d+ \[`)
	goLocation      = regexp.MustCompile(`(?m)^\t.*\.go:\d+`)
)

func chargeCard(ctx context.Context) error {
	return instatus.StartSpan(ctx, "charge", func(ctx context.Context) error {
		err := fmt.Errorf("read card: %w", &fs.PathError{Op: "open", Path: "/cards/4111 1111 1111 1111", Err: fs.ErrNotExist})
		instatus.CaptureException(ctx, err)
		return err
	})
}

func crash(ctx context.Context) {
	defer func() { _ = recover() }()
	defer instatus.RecoverWithContext(ctx)
	panic(errors.New("worker crashed"))
}

func TestInitExportsErrorsLogsAndTraces(t *testing.T) {
	server := &collector{}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()

	shutdown, err := instatus.Init(instatus.Options{
		APIKey:      "sk_test",
		SiteID:      "site_1",
		Endpoint:    httpServer.URL,
		ServiceName: "checkout",
		Release:     "checkout@1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = shutdown(context.Background()) }()
	if _, err := instatus.Init(instatus.Options{}); !errors.Is(err, instatus.ErrAlreadyInitialized) {
		t.Errorf("second Init = %v", err)
	}

	ctx := instatus.WithUser(context.Background(), instatus.User{ID: "42", Email: "ada@example.com"})
	ctx = instatus.WithTag(ctx, "plan", "pro")
	_ = chargeCard(ctx)
	crash(ctx)
	instatus.Logger().InfoContext(ctx, "order placed", "items", 3)
	instatus.Logger().Info("login", "password", "hunter2", "card", "4111 1111 1111 1111")
	if !instatus.Flush(context.Background()) {
		t.Fatal("Flush failed")
	}

	for _, path := range []string{"/v1/logs", "/v1/traces"} {
		received := server.on(path)
		if len(received) == 0 {
			t.Fatalf("nothing on %s", path)
		}
		for _, r := range received {
			if r.headers.Get("Authorization") != "Bearer sk_test" || r.headers.Get("X-Instatus-Site-Id") != "site_1" {
				t.Errorf("%s headers = %v", path, r.headers)
			}
			if r.headers.Get("Content-Type") != "application/x-protobuf" {
				t.Errorf("%s content type = %q", path, r.headers.Get("Content-Type"))
			}
		}
	}

	records := server.logRecords(t)
	handled := recordWithBody(records, "*fs.PathError: ")
	if handled == nil {
		t.Fatalf("no exception record in %d records", len(records))
	}
	if handled.SeverityNumber != 17 || handled.SeverityText != "ERROR" {
		t.Errorf("severity = %v %q", handled.SeverityNumber, handled.SeverityText)
	}
	attributes := attributesOf(handled.Attributes)
	if got := attributes["exception.message"].GetStringValue(); got != "read card: open /cards/[Filtered]: file does not exist" {
		t.Errorf("exception.message = %q", got)
	}
	if !attributes["exception.handled"].GetBoolValue() || len(attributes["log.record.uid"].GetStringValue()) != 32 {
		t.Error("exception.handled or log.record.uid missing")
	}
	if attributes["enduser.id"].GetStringValue() != "42" || attributes["plan"].GetStringValue() != "pro" {
		t.Error("scope attributes missing")
	}
	stack := attributes["exception.stacktrace"].GetStringValue()
	if !goroutineHeader.MatchString(stack) || !goLocation.MatchString(stack) {
		t.Errorf("not a Go stack:\n%s", stack)
	}
	if frame := strings.Split(stack, "\n")[1]; !strings.Contains(frame, "go_test.") || !strings.Contains(frame, "chargeCard") {
		t.Errorf("stack does not start at the caller:\n%s", stack)
	}
	if len(handled.TraceId) != 16 || len(handled.SpanId) != 8 {
		t.Error("exception record is not in the span's context")
	}

	fatal := recordWithBody(records, "*errors.errorString: worker crashed")
	if fatal == nil {
		t.Fatal("panic not reported")
	}
	fatalAttributes := attributesOf(fatal.Attributes)
	if fatal.SeverityNumber != 21 || fatalAttributes["exception.handled"].GetBoolValue() {
		t.Errorf("panic record = %v handled=%v", fatal.SeverityNumber, fatalAttributes["exception.handled"])
	}
	if fatalStack := fatalAttributes["exception.stacktrace"].GetStringValue(); !strings.Contains(fatalStack, "go_test.crash(") {
		t.Errorf("panic stack misses the panicking function:\n%s", fatalStack)
	}

	logged := recordWithBody(records, "order placed")
	if logged == nil || attributesOf(logged.Attributes)["items"].GetIntValue() != 3 {
		t.Error("slog record missing")
	}
	login := recordWithBody(records, "login")
	if login == nil {
		t.Fatal("slog login record missing")
	}
	loginAttributes := attributesOf(login.Attributes)
	if loginAttributes["password"].GetStringValue() != instatus.Filtered || loginAttributes["card"].GetStringValue() != instatus.Filtered {
		t.Errorf("slog attributes not filtered: %v", loginAttributes)
	}

	var spans tracespb.ExportTraceServiceRequest
	if err := proto.Unmarshal(server.on("/v1/traces")[0].body, &spans); err != nil {
		t.Fatal(err)
	}
	resource := attributesOf(spans.ResourceSpans[0].Resource.Attributes)
	if resource["service.name"].GetStringValue() != "checkout" || resource["telemetry.sdk.name"].GetStringValue() != instatus.SDKName || resource["telemetry.sdk.language"].GetStringValue() != "go" {
		t.Errorf("resource = %v", resource)
	}
	span := spans.ResourceSpans[0].ScopeSpans[0].Spans[0]
	if span.Name != "charge" || span.Status.GetCode() != 2 || len(span.Events) != 1 || span.Events[0].Name != "exception" {
		t.Errorf("span = %v", span)
	}

	if !instatus.Close(context.Background()) {
		t.Error("Close failed")
	}
}
