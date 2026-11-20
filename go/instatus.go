// Package instatus is the Instatus distribution of OpenTelemetry for Go,
// with the Sentry SDK's API for errors.
package instatus

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// DefaultTimeout bounds Flush, Close and Recover when the context has no deadline.
const DefaultTimeout = 2 * time.Second

const (
	defaultMaxEventsPerMinute = 300
	defaultTracesSampleRate   = 1.0
)

// ErrAlreadyInitialized is returned by Init while an earlier Init is still open.
var ErrAlreadyInitialized = errors.New("instatus: already initialized")

// Options configure Init. Every field is optional.
type Options struct {
	// APIKey falls back to INSTATUS_API_KEY.
	APIKey string
	// SiteID falls back to INSTATUS_SITE_ID.
	SiteID string
	// Endpoint replaces https://otel.instatus.com; /v1/<signal> is appended.
	Endpoint string
	// ServiceName falls back to OTEL_SERVICE_NAME, then the executable's name.
	ServiceName string
	Release     string
	Environment string
	// TracesSampleRate is the share of root traces kept, 0 to 1. Nil keeps all.
	TracesSampleRate *float64
	// BeforeSend may change an event, or return nil to drop it.
	BeforeSend func(event *Event, hint *EventHint) *Event
	// MaxEventsPerMinute caps errors sent per minute. Zero means 300.
	MaxEventsPerMinute int
	// MetricsInterval is how often metrics are exported. Zero means the SDK's default.
	MetricsInterval time.Duration
	// Disabled keeps the SDK quiet, for tests and local development.
	Disabled bool
	// Debug prints why events are dropped to stderr.
	Debug bool
}

// SampleRate returns a pointer for Options.TracesSampleRate.
func SampleRate(rate float64) *float64 {
	return &rate
}

type client struct {
	pipeline
	loggerProvider *sdklog.LoggerProvider
	tracerProvider *sdktrace.TracerProvider
	meterProvider  *sdkmetric.MeterProvider
	closeOnce      sync.Once
	closeErr       error
}

var (
	initMu sync.Mutex
	active atomic.Pointer[client]
)

func withDefaultTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, DefaultTimeout)
}

func logProvider(ctx context.Context, res *resource.Resource, target *signalExport) (*sdklog.LoggerProvider, error) {
	if target == nil {
		return sdklog.NewLoggerProvider(sdklog.WithResource(res)), nil
	}
	var options []otlploghttp.Option
	if target.URL != "" {
		options = append(options, otlploghttp.WithEndpointURL(target.URL))
	}
	if len(target.Headers) > 0 {
		options = append(options, otlploghttp.WithHeaders(target.Headers))
	}
	exporter, err := otlploghttp.New(ctx, options...)
	if err != nil {
		return nil, err
	}
	return sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(scrubProcessor{}),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
	), nil
}

func traceProvider(ctx context.Context, options Options, res *resource.Resource, target *signalExport) (*sdktrace.TracerProvider, error) {
	rate := defaultTracesSampleRate
	if options.TracesSampleRate != nil {
		rate = *options.TracesSampleRate
	}
	providerOptions := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(rate))),
	}
	if target != nil {
		var exporterOptions []otlptracehttp.Option
		if target.URL != "" {
			exporterOptions = append(exporterOptions, otlptracehttp.WithEndpointURL(target.URL))
		}
		if len(target.Headers) > 0 {
			exporterOptions = append(exporterOptions, otlptracehttp.WithHeaders(target.Headers))
		}
		exporter, err := otlptracehttp.New(ctx, exporterOptions...)
		if err != nil {
			return nil, err
		}
		providerOptions = append(providerOptions, sdktrace.WithBatcher(exporter))
	}
	return sdktrace.NewTracerProvider(providerOptions...), nil
}

func meterProvider(ctx context.Context, options Options, res *resource.Resource, target *signalExport) (*sdkmetric.MeterProvider, error) {
	if target == nil {
		return nil, nil
	}
	var exporterOptions []otlpmetrichttp.Option
	if target.URL != "" {
		exporterOptions = append(exporterOptions, otlpmetrichttp.WithEndpointURL(target.URL))
	}
	if len(target.Headers) > 0 {
		exporterOptions = append(exporterOptions, otlpmetrichttp.WithHeaders(target.Headers))
	}
	exporter, err := otlpmetrichttp.New(ctx, exporterOptions...)
	if err != nil {
		return nil, err
	}
	var readerOptions []sdkmetric.PeriodicReaderOption
	if options.MetricsInterval > 0 {
		readerOptions = append(readerOptions, sdkmetric.WithInterval(options.MetricsInterval))
	}
	return sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, readerOptions...)),
	), nil
}

func targetOf(resolved exports, target signal) *signalExport {
	found, ok := resolved[target]
	if !ok {
		return nil
	}
	return &found
}

// Disabled, the providers still exist so spans and context work, but
// nothing is exported.
func newClient(options Options) (*client, error) {
	ctx := context.Background()
	resolved := exports{}
	if !options.Disabled {
		resolved = resolveExports(options, os.Getenv)
		if _, ok := resolved[signalLogs]; !ok {
			fmt.Fprintln(os.Stderr, "[instatus] Init needs an APIKey (or INSTATUS_API_KEY) or an OTLP endpoint")
		}
	}
	res := buildResource(ctx, options)
	logs, err := logProvider(ctx, res, targetOf(resolved, signalLogs))
	if err != nil {
		return nil, err
	}
	traces, err := traceProvider(ctx, options, res, targetOf(resolved, signalTraces))
	if err != nil {
		return nil, err
	}
	metrics, err := meterProvider(ctx, options, res, targetOf(resolved, signalMetrics))
	if err != nil {
		return nil, err
	}
	limit := options.MaxEventsPerMinute
	if limit <= 0 {
		limit = defaultMaxEventsPerMinute
	}
	return &client{
		pipeline: pipeline{
			beforeSend: options.BeforeSend,
			logger:     logs.Logger(SDKName, log.WithInstrumentationVersion(Version)),
			rateCap:    newRateCap(limit, time.Minute, time.Now),
			disabled:   options.Disabled,
			debug:      options.Debug,
		},
		loggerProvider: logs,
		tracerProvider: traces,
		meterProvider:  metrics,
	}, nil
}

func (c *client) register() {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	otel.SetTracerProvider(c.tracerProvider)
	global.SetLoggerProvider(c.loggerProvider)
	if c.meterProvider != nil {
		otel.SetMeterProvider(c.meterProvider)
	}
}

func (c *client) flush(ctx context.Context) error {
	ctx, cancel := withDefaultTimeout(ctx)
	defer cancel()
	errs := []error{c.loggerProvider.ForceFlush(ctx), c.tracerProvider.ForceFlush(ctx)}
	if c.meterProvider != nil {
		errs = append(errs, c.meterProvider.ForceFlush(ctx))
	}
	return errors.Join(errs...)
}

func (c *client) close(ctx context.Context) error {
	c.closeOnce.Do(func() {
		active.CompareAndSwap(c, nil)
		ctx, cancel := withDefaultTimeout(ctx)
		defer cancel()
		errs := []error{c.loggerProvider.Shutdown(ctx), c.tracerProvider.Shutdown(ctx)}
		if c.meterProvider != nil {
			errs = append(errs, c.meterProvider.Shutdown(ctx))
		}
		c.closeErr = errors.Join(errs...)
	})
	return c.closeErr
}

// Init starts the SDK and sets the global OpenTelemetry tracer, logger and
// meter providers. Call the returned shutdown before the process exits, so
// queued errors, logs and spans are sent.
func Init(options Options) (shutdown func(context.Context) error, err error) {
	initMu.Lock()
	defer initMu.Unlock()
	if active.Load() != nil {
		return nil, ErrAlreadyInitialized
	}
	created, err := newClient(options)
	if err != nil {
		return nil, err
	}
	created.register()
	active.Store(created)
	return created.close, nil
}

// CaptureException reports an error you handled and returns its event id.
// The scope on ctx and its active span are used.
func CaptureException(ctx context.Context, err error) string {
	current := active.Load()
	if current == nil || err == nil {
		return ""
	}
	event := eventFromError(err, true, LevelError)
	return current.capture(ctx, event, &EventHint{OriginalException: err})
}

// CaptureMessage reports a message. Error and fatal messages are issues in
// Errors; lower levels are plain logs.
func CaptureMessage(ctx context.Context, message string, level Level) string {
	current := active.Load()
	if current == nil {
		return ""
	}
	return current.capture(ctx, eventFromMessage(message, level), &EventHint{})
}

func captureRecovered(ctx context.Context, recovered any) {
	current := active.Load()
	if current == nil {
		return
	}
	hint := &EventHint{RecoveredException: recovered}
	if err, ok := recovered.(error); ok {
		hint.OriginalException = err
	}
	current.capture(ctx, eventFromRecovered(recovered), hint)
	_ = current.flush(ctx)
}

// Recover reports a panic as an unhandled fatal error, flushes, then panics
// again so Go prints it and exits as usual. Use it as defer instatus.Recover().
func Recover() {
	if recovered := recover(); recovered != nil {
		captureRecovered(context.Background(), recovered)
		panic(recovered)
	}
}

// RecoverWithContext is Recover with the scope and span of ctx.
func RecoverWithContext(ctx context.Context) {
	if recovered := recover(); recovered != nil {
		captureRecovered(ctx, recovered)
		panic(recovered)
	}
}

// StartSpan runs fn inside a span and ends it when fn returns. An error or
// a panic marks the span as failed.
func StartSpan(ctx context.Context, name string, fn func(ctx context.Context) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	tracer := otel.Tracer(SDKName, trace.WithInstrumentationVersion(Version))
	ctx, span := tracer.Start(ctx, name)
	panicking := true
	defer func() {
		if panicking {
			span.SetStatus(codes.Error, "panic")
		}
		span.End()
	}()
	err := fn(ctx)
	panicking = false
	if err != nil {
		span.SetStatus(codes.Error, scrubText(err.Error()))
	}
	return err
}

// Flush sends what is queued. It returns false if ctx (or DefaultTimeout)
// ends first or an export fails.
func Flush(ctx context.Context) bool {
	current := active.Load()
	if current == nil {
		return true
	}
	return current.flush(ctx) == nil
}

// Close flushes and shuts the SDK down. Init can be called again after it.
func Close(ctx context.Context) bool {
	current := active.Load()
	if current == nil {
		return true
	}
	return current.close(ctx) == nil
}
