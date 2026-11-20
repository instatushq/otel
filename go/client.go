package instatus

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/trace"
)

var frameArguments = regexp.MustCompile(`\(.*\)$`)

// The goroutine number and argument values change on every call, so the
// signature keeps only the functions and lines.
func stackSignature(stack string) string {
	lines := strings.Split(stack, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if goroutineHeader.MatchString(line) {
			continue
		}
		if !strings.HasPrefix(line, "\t") {
			line = frameArguments.ReplaceAllString(line, "")
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func signatureOf(event *Event) string {
	if exception := event.Exception; exception != nil {
		return exception.Type + "|" + exception.Value + "|" + stackSignature(exception.Stacktrace)
	}
	return "message|" + event.Message
}

// Same as Sentry's Dedupe integration: an event identical to the one just
// sent is a re-report of one error.
type dedupe struct {
	mu       sync.Mutex
	previous string
}

func (d *dedupe) isDuplicate(event *Event) bool {
	signature := signatureOf(event)
	d.mu.Lock()
	defer d.mu.Unlock()
	duplicate := signature == d.previous
	d.previous = signature
	return duplicate
}

type rateCap struct {
	mu          sync.Mutex
	limit       int
	window      time.Duration
	now         func() time.Time
	windowStart time.Time
	count       int
}

func newRateCap(limit int, window time.Duration, now func() time.Time) *rateCap {
	return &rateCap{limit: limit, window: window, now: now, windowStart: now()}
}

func (r *rateCap) take() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := r.now()
	if current.Sub(r.windowStart) >= r.window {
		r.windowStart = current
		r.count = 0
	}
	if r.count >= r.limit {
		return false
	}
	r.count++
	return true
}

type pipeline struct {
	beforeSend func(*Event, *EventHint) *Event
	logger     log.Logger
	dedupe     dedupe
	rateCap    *rateCap
	disabled   bool
	debug      bool
}

func (p *pipeline) debugf(format string, args ...any) {
	if p.debug {
		fmt.Fprintf(os.Stderr, "[instatus] "+format+"\n", args...)
	}
}

func (p *pipeline) runBeforeSend(event *Event, hint *EventHint) (kept *Event) {
	if p.beforeSend == nil {
		return event
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			p.debugf("BeforeSend panicked: %v", recovered)
			kept = nil
		}
	}()
	return p.beforeSend(event, hint)
}

// Reporting must never panic into an app that is already handling an error.
func (p *pipeline) capture(ctx context.Context, event *Event, hint *EventHint) string {
	defer func() {
		if recovered := recover(); recovered != nil {
			p.debugf("could not send an event: %v", recovered)
		}
	}()
	if p.disabled {
		return event.EventID
	}
	if ctx == nil {
		ctx = context.Background()
	}
	currentScope(ctx).applyTo(event)
	hint.Context = ctx
	kept := p.runBeforeSend(event, hint)
	if kept == nil {
		p.debugf("BeforeSend dropped an event")
		return event.EventID
	}
	if p.dedupe.isDuplicate(kept) {
		p.debugf("dropped a duplicate event")
		return kept.EventID
	}
	if !p.rateCap.take() {
		p.debugf("rate cap reached")
		return kept.EventID
	}
	record := eventToRecord(kept)
	recordOnSpan(trace.SpanFromContext(ctx), kept, record)
	p.logger.Emit(ctx, record.toOTel())
	return kept.EventID
}

func (r logRecord) toOTel() log.Record {
	var record log.Record
	record.SetTimestamp(r.Timestamp)
	record.SetObservedTimestamp(time.Now())
	record.SetSeverity(r.Severity)
	record.SetSeverityText(r.SeverityText)
	record.SetBody(attribute.StringValue(r.Body))
	record.AddAttributes(r.Attributes...)
	return record
}

var spanEventKeys = []string{"exception.type", "exception.message", "exception.stacktrace"}

// The span event is what OpenTelemetry's own RecordError writes. It is built
// from the filtered record, so traces carry nothing the log doesn't.
func recordOnSpan(span trace.Span, event *Event, record logRecord) {
	if event.Exception == nil || !span.IsRecording() {
		return
	}
	attributes := make([]attribute.KeyValue, 0, len(spanEventKeys))
	message := ""
	for _, key := range spanEventKeys {
		if value, ok := record.attribute(key); ok {
			attributes = append(attributes, attribute.String(key, value.AsString()))
			if key == "exception.message" {
				message = value.AsString()
			}
		}
	}
	span.AddEvent("exception", trace.WithAttributes(attributes...))
	if !event.Exception.Handled {
		span.SetStatus(codes.Error, message)
	}
}
