package instatus

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

// scrubProcessor filters records from slog and any other OpenTelemetry log
// bridge before export. The SDK's own records were filtered as they were
// built, so they pass unchanged.
type scrubProcessor struct{}

func (scrubProcessor) OnEmit(_ context.Context, record *sdklog.Record) error {
	if record.InstrumentationScope().Name == SDKName {
		return nil
	}
	record.SetBody(scrubLogValue("", record.Body(), 0))
	changed := false
	attributes := make([]attribute.KeyValue, 0, record.AttributesLen())
	record.WalkAttributes(func(field attribute.KeyValue) bool {
		scrubbed := scrubLogValue(string(field.Key), field.Value, 0)
		changed = changed || scrubbed != field.Value
		attributes = append(attributes, attribute.KeyValue{Key: field.Key, Value: scrubbed})
		return true
	})
	if changed {
		record.SetAttributes(attributes...)
	}
	return nil
}

func (scrubProcessor) Enabled(context.Context, sdklog.EnabledParameters) bool { return true }

func (scrubProcessor) Shutdown(context.Context) error { return nil }

func (scrubProcessor) ForceFlush(context.Context) error { return nil }

func scrubLogValue(key string, value attribute.Value, depth int) attribute.Value {
	if isSensitiveKey(key) {
		return attribute.StringValue(Filtered)
	}
	switch value.Type() {
	case attribute.STRING:
		return attribute.StringValue(scrubLogString(key, value.AsString()))
	case attribute.MAP:
		if depth >= maxScrubDepth {
			return attribute.StringValue(truncated)
		}
		entries := value.AsMap()
		scrubbed := make([]attribute.KeyValue, len(entries))
		for index, entry := range entries {
			scrubbed[index] = attribute.KeyValue{Key: entry.Key, Value: scrubLogValue(string(entry.Key), entry.Value, depth+1)}
		}
		return attribute.MapValue(scrubbed...)
	case attribute.SLICE:
		if depth >= maxScrubDepth {
			return attribute.StringValue(truncated)
		}
		items := value.AsSlice()
		scrubbed := make([]attribute.Value, len(items))
		for index, item := range items {
			scrubbed[index] = scrubLogValue("", item, depth+1)
		}
		return attribute.SliceValue(scrubbed...)
	case attribute.STRINGSLICE:
		items := value.AsStringSlice()
		scrubbed := make([]string, len(items))
		for index, item := range items {
			scrubbed[index] = scrubLogString("", item)
		}
		return attribute.StringSliceValue(scrubbed)
	}
	return value
}

// Log attributes are often named after what the URL is for (redirect,
// callback), so a value that starts with a scheme counts as a URL too.
func scrubLogString(key, value string) string {
	if urlScheme.MatchString(value) {
		return scrubURL(value)
	}
	return scrubString(key, value)
}
