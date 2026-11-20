package com.instatus.otel;

import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.logs.Logger;
import io.opentelemetry.api.metrics.MeterProvider;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporter;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporterBuilder;
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporter;
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporterBuilder;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporterBuilder;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.SdkLoggerProviderBuilder;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.SdkMeterProviderBuilder;
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.SdkTracerProviderBuilder;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.TimeUnit;

final class Client {
  static final java.util.logging.Logger LOG = java.util.logging.Logger.getLogger(Instatus.class.getName());

  private static final long MINUTE_MILLIS = 60_000;
  private static final List<String> SPAN_EVENT_KEYS =
      List.of("exception.type", "exception.message", "exception.stacktrace");

  final InstatusOptions options;
  final OpenTelemetrySdk sdk;
  private final Logger logger;
  private final Dedupe dedupe = new Dedupe();
  private final RateCap rateCap;
  private final Set<Throwable> captured = Collections.newSetFromMap(Collections.synchronizedMap(new WeakHashMap<>()));
  private Thread.UncaughtExceptionHandler previousUncaughtHandler;
  private Thread.UncaughtExceptionHandler uncaughtHandler;
  private InstatusLogHandler logHandler;
  private Thread shutdownHook;

  private Client(InstatusOptions options, OpenTelemetrySdk sdk) {
    this.options = options;
    this.sdk = sdk;
    this.logger =
        sdk.getSdkLoggerProvider().loggerBuilder(Version.SDK_NAME).setInstrumentationVersion(Version.VERSION).build();
    this.rateCap = new RateCap(options.getMaxEventsPerMinute(), MINUTE_MILLIS, () -> System.nanoTime() / 1_000_000);
  }

  // Disabled, the providers still exist so startSpan and context work, but nothing is exported.
  static Client start(InstatusOptions options) {
    Map<String, String> env = options.environmentVariables();
    Map<Exports.Signal, Exports.Target> exports = Map.of();
    if (options.isEnabled()) exports = Exports.resolve(options, env);
    boolean hasLogsExport = exports.containsKey(Exports.Signal.LOGS) || !options.getLogRecordProcessors().isEmpty();
    if (options.isEnabled() && !hasLogsExport) {
      LOG.warning("[instatus] init needs an apiKey (or INSTATUS_API_KEY) or an OTLP endpoint");
    }
    Resource resource = InstatusResource.build(options, env);
    OpenTelemetrySdk sdk =
        OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider(options, resource, exports.get(Exports.Signal.TRACES)))
            .setLoggerProvider(loggerProvider(options, resource, exports.get(Exports.Signal.LOGS)))
            .setMeterProvider(meterProvider(options, resource, exports.get(Exports.Signal.METRICS)))
            .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
            .build();
    return new Client(options, sdk);
  }

  private static SdkTracerProvider tracerProvider(InstatusOptions options, Resource resource, Exports.Target target) {
    SdkTracerProviderBuilder builder =
        SdkTracerProvider.builder()
            .setResource(resource)
            .setSampler(Sampler.parentBased(Sampler.traceIdRatioBased(options.getTracesSampleRate())));
    for (SpanProcessor processor : options.getSpanProcessors()) builder.addSpanProcessor(processor);
    if (target != null) {
      OtlpHttpSpanExporterBuilder exporter =
          OtlpHttpSpanExporter.builder().setEndpoint(target.url).setMeterProvider(MeterProvider.noop());
      target.headers.forEach(exporter::addHeader);
      builder.addSpanProcessor(BatchSpanProcessor.builder(exporter.build()).build());
    }
    return builder.build();
  }

  private static SdkLoggerProvider loggerProvider(InstatusOptions options, Resource resource, Exports.Target target) {
    SdkLoggerProviderBuilder builder = SdkLoggerProvider.builder().setResource(resource);
    for (LogRecordProcessor processor : options.getLogRecordProcessors()) builder.addLogRecordProcessor(processor);
    if (target != null) {
      OtlpHttpLogRecordExporterBuilder exporter =
          OtlpHttpLogRecordExporter.builder().setEndpoint(target.url).setMeterProvider(MeterProvider.noop());
      target.headers.forEach(exporter::addHeader);
      builder.addLogRecordProcessor(BatchLogRecordProcessor.builder(exporter.build()).build());
    }
    return builder.build();
  }

  private static SdkMeterProvider meterProvider(InstatusOptions options, Resource resource, Exports.Target target) {
    SdkMeterProviderBuilder builder = SdkMeterProvider.builder().setResource(resource);
    if (target != null) {
      OtlpHttpMetricExporterBuilder exporter =
          OtlpHttpMetricExporter.builder().setEndpoint(target.url).setMeterProvider(MeterProvider.noop());
      target.headers.forEach(exporter::addHeader);
      builder.registerMetricReader(
          PeriodicMetricReader.builder(exporter.build()).setInterval(options.getMetricsExportInterval()).build());
    }
    return builder.build();
  }

  void install() {
    if (!options.isEnabled()) return;
    previousUncaughtHandler = Thread.getDefaultUncaughtExceptionHandler();
    uncaughtHandler = new UncaughtExceptionHandler(previousUncaughtHandler, options.getShutdownTimeout());
    Thread.setDefaultUncaughtExceptionHandler(uncaughtHandler);
    if (!java.util.logging.Level.OFF.equals(options.getLoggingLevel())) {
      logHandler = new InstatusLogHandler();
      logHandler.setLevel(options.getLoggingLevel());
      rootLogger().addHandler(logHandler);
    }
    shutdownHook = new Thread(() -> flush(options.getShutdownTimeout()), "instatus-flush");
    Runtime.getRuntime().addShutdownHook(shutdownHook);
  }

  void uninstall() {
    if (uncaughtHandler != null && Thread.getDefaultUncaughtExceptionHandler() == uncaughtHandler) {
      Thread.setDefaultUncaughtExceptionHandler(previousUncaughtHandler);
    }
    if (logHandler != null) rootLogger().removeHandler(logHandler);
    if (shutdownHook == null) return;
    try {
      Runtime.getRuntime().removeShutdownHook(shutdownHook);
    } catch (IllegalStateException shuttingDown) {
      return;
    }
  }

  private static java.util.logging.Logger rootLogger() {
    return java.util.logging.Logger.getLogger("");
  }

  // Reporting must never throw into an app that is already handling an error.
  String capture(Event event) {
    try {
      send(event);
    } catch (RuntimeException failure) {
      debug("could not send an event: " + failure);
    }
    return event.getEventId();
  }

  private void send(Event event) {
    if (!options.isEnabled()) return;
    Throwable throwable = event.getThrowable();
    if (throwable != null && !captured.add(throwable)) {
      debug("dropped an event: already captured");
      return;
    }
    Span span = Span.current();
    if (event.getRelease() == null) event.setRelease(options.getRelease());
    if (event.getEnvironment() == null) event.setEnvironment(options.getEnvironment());
    Event result = beforeSend(event);
    if (result == null) {
      debug("beforeSend dropped an event");
      return;
    }
    if (dedupe.isDuplicate(result)) {
      debug("dropped a duplicate event");
      return;
    }
    if (!rateCap.take()) {
      debug("rate cap reached");
      return;
    }
    ErrorLogRecord record = RecordMapper.toLogRecord(result);
    recordOnSpan(span, result, record);
    emit(record);
  }

  private Event beforeSend(Event event) {
    BeforeSendCallback callback = options.getBeforeSend();
    if (callback == null) return event;
    try {
      return callback.execute(event);
    } catch (RuntimeException failure) {
      debug("beforeSend threw: " + failure);
      return null;
    }
  }

  // Built from the scrubbed record, so traces carry nothing the log doesn't.
  private static void recordOnSpan(Span span, Event event, ErrorLogRecord record) {
    if (!span.isRecording() || !event.hasException()) return;
    AttributesBuilder attributes = Attributes.builder();
    for (String key : SPAN_EVENT_KEYS) {
      Object value = record.attributes.get(key);
      if (value != null) attributes.put(key, String.valueOf(value));
    }
    span.addEvent("exception", attributes.build());
    if (Boolean.FALSE.equals(event.getHandled())) {
      span.setStatus(StatusCode.ERROR, String.valueOf(record.attributes.get("exception.message")));
    }
  }

  private void emit(ErrorLogRecord record) {
    logger
        .logRecordBuilder()
        .setTimestamp(record.timestamp)
        .setSeverity(record.level.getSeverity())
        .setSeverityText(record.level.getSeverityText())
        .setBody(record.body)
        .setAllAttributes(toAttributes(record.attributes))
        .setContext(Context.current())
        .emit();
  }

  static Attributes toAttributes(Map<String, Object> values) {
    AttributesBuilder attributes = Attributes.builder();
    values.forEach(
        (key, value) -> {
          if (value instanceof String) attributes.put(key, (String) value);
          else if (value instanceof Long) attributes.put(key, (long) value);
          else if (value instanceof Double) attributes.put(key, (double) value);
          else if (value instanceof Boolean) attributes.put(key, (boolean) value);
        });
    return attributes.build();
  }

  boolean flush(Duration timeout) {
    CompletableResultCode result =
        CompletableResultCode.ofAll(
            List.of(
                sdk.getSdkTracerProvider().forceFlush(),
                sdk.getSdkLoggerProvider().forceFlush(),
                sdk.getSdkMeterProvider().forceFlush()));
    return result.join(timeout.toMillis(), TimeUnit.MILLISECONDS).isSuccess();
  }

  boolean shutdown(Duration timeout) {
    return sdk.shutdown().join(timeout.toMillis(), TimeUnit.MILLISECONDS).isSuccess();
  }

  private void debug(String message) {
    if (options.isDebug()) LOG.warning("[instatus] " + message);
  }
}
