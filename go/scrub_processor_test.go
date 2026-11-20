package instatus

import (
	"context"
	"log/slog"
	"sync"
	"testing"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

type recordingExporter struct {
	mu      sync.Mutex
	records []sdklog.Record
}

func (e *recordingExporter) Export(_ context.Context, records []sdklog.Record) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, record := range records {
		e.records = append(e.records, record.Clone())
	}
	return nil
}

func (e *recordingExporter) Shutdown(context.Context) error { return nil }

func (e *recordingExporter) ForceFlush(context.Context) error { return nil }

func newScrubbedProvider(t *testing.T) (*sdklog.LoggerProvider, *recordingExporter) {
	t.Helper()
	exporter := &recordingExporter{}
	provider := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(scrubProcessor{}),
		sdklog.WithProcessor(sdklog.NewSimpleProcessor(exporter)),
	)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	return provider, exporter
}

func exportedAttributes(record sdklog.Record) map[string]log.Value {
	found := map[string]log.Value{}
	record.WalkAttributes(func(attribute log.KeyValue) bool {
		found[attribute.Key] = attribute.Value
		return true
	})
	return found
}

func mapOf(value log.Value) map[string]log.Value {
	found := map[string]log.Value{}
	for _, entry := range value.AsMap() {
		found[entry.Key] = entry.Value
	}
	return found
}

func TestSlogRecordsAreFiltered(t *testing.T) {
	provider, exporter := newScrubbedProvider(t)
	logger := slog.New(otelslog.NewHandler(slogScope, otelslog.WithLoggerProvider(provider)))

	logger.Info("paid with 4111 1111 1111 1111",
		"password", "hunter2",
		"card", "4111 1111 1111 1111",
		"redirect", "https://ada:secret@example.com/callback?token=abc&page=2",
		"items", 3,
		slog.Group("request", "cookie", "c=1", "path", "/checkout", slog.Group("headers", "Authorization", "Bearer t")),
	)
	logger.WithGroup("payment").Info("charged", "api_key", "sk_live", "plan", "pro")

	if len(exporter.records) != 2 {
		t.Fatalf("exported %d records", len(exporter.records))
	}
	first := exporter.records[0]
	if got := first.Body().AsString(); got != "paid with [Filtered]" {
		t.Errorf("body = %q", got)
	}
	attributes := exportedAttributes(first)
	for key, want := range map[string]string{
		"password": Filtered,
		"card":     Filtered,
		"redirect": "https://example.com/callback?token=[Filtered]&page=2",
	} {
		if got := attributes[key].AsString(); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if attributes["items"].AsInt64() != 3 {
		t.Errorf("items = %v", attributes["items"])
	}
	request := mapOf(attributes["request"])
	if request["cookie"].AsString() != Filtered || request["path"].AsString() != "/checkout" {
		t.Errorf("request = %v", request)
	}
	if headers := mapOf(request["headers"]); headers["Authorization"].AsString() != Filtered {
		t.Errorf("headers = %v", headers)
	}
	payment := mapOf(exportedAttributes(exporter.records[1])["payment"])
	if payment["api_key"].AsString() != Filtered || payment["plan"].AsString() != "pro" {
		t.Errorf("payment = %v", payment)
	}
}

func TestSDKRecordsPassTheProcessorUnchanged(t *testing.T) {
	provider, exporter := newScrubbedProvider(t)
	var record log.Record
	record.SetBody(log.StringValue("Error: order 4111111111111111"))
	record.AddAttributes(log.String("token", "kept"))
	provider.Logger(SDKName).Emit(context.Background(), record)

	exported := exporter.records[0]
	if got := exported.Body().AsString(); got != "Error: order 4111111111111111" {
		t.Errorf("body = %q", got)
	}
	if got := exportedAttributes(exported)["token"].AsString(); got != "kept" {
		t.Errorf("token = %q", got)
	}
}

func TestScrubLogValue(t *testing.T) {
	nested := log.StringValue("deep")
	for range maxScrubDepth + 1 {
		nested = log.MapValue(log.KeyValue{Key: "level", Value: nested})
	}
	cases := []struct {
		key   string
		value log.Value
		want  log.Value
	}{
		{"session", log.Int64Value(7), log.StringValue(Filtered)},
		{"note", log.StringValue("card 4111-1111-1111-1111"), log.StringValue("card [Filtered]")},
		{"callback_url", log.StringValue("/cb?secret=1"), log.StringValue("/cb?secret=[Filtered]")},
		{"plain", log.StringValue("ftp://u:p@files.example.com/a"), log.StringValue("ftp://files.example.com/a")},
		{"ids", log.SliceValue(log.StringValue("4111111111111111"), log.Int64Value(4)), log.SliceValue(log.StringValue(Filtered), log.Int64Value(4))},
		{"blob", log.BytesValue([]byte("4111111111111111")), log.BytesValue([]byte("4111111111111111"))},
	}
	for _, c := range cases {
		if got := scrubLogValue(c.key, c.value, 0); !got.Equal(c.want) {
			t.Errorf("scrubLogValue(%q, %v) = %v, want %v", c.key, c.value, got, c.want)
		}
	}
	scrubbed := scrubLogValue("", nested, 0)
	for range maxScrubDepth {
		scrubbed = scrubbed.AsMap()[0].Value
	}
	if scrubbed.AsString() != truncated {
		t.Errorf("depth %d = %v", maxScrubDepth, scrubbed)
	}
}
