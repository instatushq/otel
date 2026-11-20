package instatus

import (
	"context"

	"go.opentelemetry.io/otel/log"
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
	attributes := make([]log.KeyValue, 0, record.AttributesLen())
	record.WalkAttributes(func(attribute log.KeyValue) bool {
		scrubbed := scrubLogValue(attribute.Key, attribute.Value, 0)
		changed = changed || !scrubbed.Equal(attribute.Value)
		attributes = append(attributes, log.KeyValue{Key: attribute.Key, Value: scrubbed})
		return true
	})
	if changed {
		record.SetAttributes(attributes...)
	}
	return nil
}

func (scrubProcessor) Shutdown(context.Context) error { return nil }

func (scrubProcessor) ForceFlush(context.Context) error { return nil }

func scrubLogValue(key string, value log.Value, depth int) log.Value {
	if isSensitiveKey(key) {
		return log.StringValue(Filtered)
	}
	switch value.Kind() {
	case log.KindString:
		return log.StringValue(scrubLogString(key, value.AsString()))
	case log.KindMap:
		if depth >= maxScrubDepth {
			return log.StringValue(truncated)
		}
		entries := value.AsMap()
		scrubbed := make([]log.KeyValue, len(entries))
		for index, entry := range entries {
			scrubbed[index] = log.KeyValue{Key: entry.Key, Value: scrubLogValue(entry.Key, entry.Value, depth+1)}
		}
		return log.MapValue(scrubbed...)
	case log.KindSlice:
		if depth >= maxScrubDepth {
			return log.StringValue(truncated)
		}
		items := value.AsSlice()
		scrubbed := make([]log.Value, len(items))
		for index, item := range items {
			scrubbed[index] = scrubLogValue("", item, depth+1)
		}
		return log.SliceValue(scrubbed...)
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
