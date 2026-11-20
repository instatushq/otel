package instatus

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/log/embedded"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type recordingLogger struct {
	embedded.Logger
	mu      sync.Mutex
	records []log.Record
}

func (l *recordingLogger) Emit(_ context.Context, record log.Record) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.records = append(l.records, record)
}

func (l *recordingLogger) Enabled(context.Context, log.EnabledParameters) bool { return true }

func newTestPipeline(limit int) (*pipeline, *recordingLogger) {
	logger := &recordingLogger{}
	return &pipeline{logger: logger, rateCap: newRateCap(limit, time.Minute, time.Now)}, logger
}

func recordAttribute(record log.Record, key string) string {
	value := ""
	record.WalkAttributes(func(attribute log.KeyValue) bool {
		if attribute.Key == key {
			value = attribute.Value.String()
			return false
		}
		return true
	})
	return value
}

func TestIdenticalErrorsInARowAreSentOnce(t *testing.T) {
	resetGlobalScope(t)
	p, logger := newTestPipeline(100)
	err := errors.New("boom")
	for range 2 {
		p.capture(context.Background(), eventFromError(err, true, LevelError), &EventHint{})
	}
	p.capture(context.Background(), eventFromError(errors.New("other"), true, LevelError), &EventHint{})
	p.capture(context.Background(), eventFromError(err, true, LevelError), &EventHint{})
	if len(logger.records) != 3 {
		t.Errorf("sent %d records, want 3", len(logger.records))
	}
}

func TestStackSignatureIgnoresGoroutineAndArguments(t *testing.T) {
	first := "goroutine 7 [running]:\nmain.handle(0xc000010000)\n\t/app/main.go:12 +0x1d\n"
	second := "goroutine 9 [running]:\nmain.handle(0xc000020000)\n\t/app/main.go:12 +0x1d\n"
	if stackSignature(first) != stackSignature(second) {
		t.Error("signatures differ")
	}
}

func TestRateCap(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newRateCap(2, time.Minute, func() time.Time { return now })
	if !limiter.take() || !limiter.take() || limiter.take() {
		t.Fatal("cap of 2 not enforced")
	}
	now = now.Add(time.Minute)
	if !limiter.take() {
		t.Error("window did not reset")
	}
}

func TestPipelineStopsAtTheRateCap(t *testing.T) {
	resetGlobalScope(t)
	p, logger := newTestPipeline(3)
	for index := range 5 {
		p.capture(context.Background(), eventFromMessage(string(rune('a'+index)), LevelError), &EventHint{})
	}
	if len(logger.records) != 3 {
		t.Errorf("sent %d records, want 3", len(logger.records))
	}
}

func TestBeforeSendChangesOrDropsEvents(t *testing.T) {
	resetGlobalScope(t)
	p, logger := newTestPipeline(100)
	original := errors.New("card declined")
	var hints []*EventHint
	p.beforeSend = func(event *Event, hint *EventHint) *Event {
		hints = append(hints, hint)
		if event.Message == "drop me" {
			return nil
		}
		event.Tags["checked"] = "yes"
		return event
	}
	ctx := WithTag(context.Background(), "step", "charge")
	id := p.capture(ctx, eventFromError(original, true, LevelError), &EventHint{OriginalException: original})
	p.capture(ctx, eventFromMessage("drop me", LevelError), &EventHint{})

	if len(logger.records) != 1 {
		t.Fatalf("sent %d records, want 1", len(logger.records))
	}
	record := logger.records[0]
	if recordAttribute(record, "checked") != "yes" || recordAttribute(record, "step") != "charge" {
		t.Error("BeforeSend change or scope missing")
	}
	if recordAttribute(record, "log.record.uid") != id {
		t.Errorf("event id %q not on record", id)
	}
	if hints[0].OriginalException != original || hints[0].Context != ctx {
		t.Errorf("hint = %#v", hints[0])
	}
}

func TestBeforeSendRunsBeforeTheFilters(t *testing.T) {
	resetGlobalScope(t)
	p, logger := newTestPipeline(100)
	p.beforeSend = func(event *Event, _ *EventHint) *Event {
		if event.Extra["password"] != "hunter2" {
			t.Error("BeforeSend saw a filtered value")
		}
		return event
	}
	ctx := WithExtra(context.Background(), "password", "hunter2")
	p.capture(ctx, eventFromMessage("login failed", LevelError), &EventHint{})
	if got := recordAttribute(logger.records[0], "extra.password"); got != Filtered {
		t.Errorf("extra.password = %q", got)
	}
}

func TestPanickingBeforeSendDropsTheEvent(t *testing.T) {
	resetGlobalScope(t)
	p, logger := newTestPipeline(100)
	p.beforeSend = func(*Event, *EventHint) *Event { panic("bug in hook") }
	p.capture(context.Background(), eventFromMessage("x", LevelError), &EventHint{})
	if len(logger.records) != 0 {
		t.Error("event sent despite panic")
	}
}

func TestDisabledPipelineSendsNothing(t *testing.T) {
	p, logger := newTestPipeline(100)
	p.disabled = true
	if id := p.capture(context.Background(), eventFromMessage("x", LevelError), &EventHint{}); len(id) != 32 {
		t.Errorf("id = %q", id)
	}
	if len(logger.records) != 0 {
		t.Error("disabled pipeline sent a record")
	}
}

func TestUnhandledErrorsFailTheActiveSpan(t *testing.T) {
	resetGlobalScope(t)
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	ctx, span := provider.Tracer("test").Start(context.Background(), "checkout")
	p, _ := newTestPipeline(100)
	p.capture(ctx, eventFromError(errors.New("charge 4111 1111 1111 1111 failed"), false, LevelFatal), &EventHint{})
	span.End()

	status := recorder.Ended()[0].Status()
	if status.Code != codes.Error || status.Description != "charge [Filtered] failed" {
		t.Errorf("status = %#v", status)
	}
}

func TestErrorsGoOnTheActiveSpan(t *testing.T) {
	resetGlobalScope(t)
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	ctx, span := provider.Tracer("test").Start(context.Background(), "checkout")
	p, logger := newTestPipeline(100)
	p.capture(ctx, eventFromError(errors.New("charge 4111 1111 1111 1111 failed"), true, LevelError), &EventHint{})
	span.End()

	ended := recorder.Ended()[0]
	if ended.Status().Code != codes.Unset {
		t.Errorf("handled error set status %#v", ended.Status())
	}
	events := ended.Events()
	if len(events) != 1 || events[0].Name != "exception" {
		t.Fatalf("events = %#v", events)
	}
	for _, attribute := range events[0].Attributes {
		if attribute.Key == "exception.message" && attribute.Value.AsString() != "charge [Filtered] failed" {
			t.Errorf("span event not filtered: %q", attribute.Value.AsString())
		}
	}
	if len(logger.records) != 1 {
		t.Error("record not emitted")
	}
}

func TestCaptureBeforeInitIsANoop(t *testing.T) {
	if id := CaptureException(context.Background(), errors.New("x")); id != "" {
		t.Errorf("id = %q", id)
	}
	if !Flush(context.Background()) || !Close(context.Background()) {
		t.Error("Flush and Close must succeed without Init")
	}
}
