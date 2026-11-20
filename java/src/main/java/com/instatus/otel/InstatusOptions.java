package com.instatus.otel;

import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.trace.SpanProcessor;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Options for {@link Instatus#init(InstatusOptions)}. Build them with {@link #builder()}. */
public final class InstatusOptions {
  static final int DEFAULT_MAX_EVENTS_PER_MINUTE = 300;
  static final Duration DEFAULT_SHUTDOWN_TIMEOUT = Duration.ofSeconds(2);
  static final Duration DEFAULT_METRICS_EXPORT_INTERVAL = Duration.ofSeconds(60);

  private final String apiKey;
  private final String siteId;
  private final String endpoint;
  private final String serviceName;
  private final String release;
  private final String environment;
  private final double tracesSampleRate;
  private final BeforeSendCallback beforeSend;
  private final int maxEventsPerMinute;
  private final boolean enabled;
  private final boolean debug;
  private final java.util.logging.Level loggingLevel;
  private final Duration metricsExportInterval;
  private final Duration shutdownTimeout;
  private final List<SpanProcessor> spanProcessors;
  private final List<LogRecordProcessor> logRecordProcessors;
  private final Map<String, String> environmentVariables;

  private InstatusOptions(Builder builder) {
    apiKey = builder.apiKey;
    siteId = builder.siteId;
    endpoint = builder.endpoint;
    serviceName = builder.serviceName;
    release = builder.release;
    environment = builder.environment;
    tracesSampleRate = builder.tracesSampleRate;
    beforeSend = builder.beforeSend;
    maxEventsPerMinute = builder.maxEventsPerMinute;
    enabled = builder.enabled;
    debug = builder.debug;
    loggingLevel = builder.loggingLevel;
    metricsExportInterval = builder.metricsExportInterval;
    shutdownTimeout = builder.shutdownTimeout;
    spanProcessors = Collections.unmodifiableList(new ArrayList<>(builder.spanProcessors));
    logRecordProcessors = Collections.unmodifiableList(new ArrayList<>(builder.logRecordProcessors));
    environmentVariables = builder.environmentVariables;
  }

  public static Builder builder() {
    return new Builder();
  }

  public String getApiKey() {
    return apiKey;
  }

  public String getSiteId() {
    return siteId;
  }

  public String getEndpoint() {
    return endpoint;
  }

  public String getServiceName() {
    return serviceName;
  }

  public String getRelease() {
    return release;
  }

  public String getEnvironment() {
    return environment;
  }

  public double getTracesSampleRate() {
    return tracesSampleRate;
  }

  public BeforeSendCallback getBeforeSend() {
    return beforeSend;
  }

  public int getMaxEventsPerMinute() {
    return maxEventsPerMinute;
  }

  public boolean isEnabled() {
    return enabled;
  }

  public boolean isDebug() {
    return debug;
  }

  public java.util.logging.Level getLoggingLevel() {
    return loggingLevel;
  }

  public Duration getMetricsExportInterval() {
    return metricsExportInterval;
  }

  public Duration getShutdownTimeout() {
    return shutdownTimeout;
  }

  public List<SpanProcessor> getSpanProcessors() {
    return spanProcessors;
  }

  public List<LogRecordProcessor> getLogRecordProcessors() {
    return logRecordProcessors;
  }

  Map<String, String> environmentVariables() {
    return environmentVariables == null ? System.getenv() : environmentVariables;
  }

  public static final class Builder {
    private String apiKey;
    private String siteId;
    private String endpoint;
    private String serviceName;
    private String release;
    private String environment;
    private double tracesSampleRate = 1;
    private BeforeSendCallback beforeSend;
    private int maxEventsPerMinute = DEFAULT_MAX_EVENTS_PER_MINUTE;
    private boolean enabled = true;
    private boolean debug;
    private java.util.logging.Level loggingLevel = java.util.logging.Level.INFO;
    private Duration metricsExportInterval = DEFAULT_METRICS_EXPORT_INTERVAL;
    private Duration shutdownTimeout = DEFAULT_SHUTDOWN_TIMEOUT;
    private final List<SpanProcessor> spanProcessors = new ArrayList<>();
    private final List<LogRecordProcessor> logRecordProcessors = new ArrayList<>();
    private Map<String, String> environmentVariables;

    private Builder() {}

    /** A secret API key; sends every signal to the Instatus collector. Defaults to {@code INSTATUS_API_KEY}. */
    public Builder apiKey(String apiKey) {
      this.apiKey = apiKey;
      return this;
    }

    /** The status page's site id. Defaults to {@code INSTATUS_SITE_ID}. */
    public Builder siteId(String siteId) {
      this.siteId = siteId;
      return this;
    }

    /** Another OTLP/HTTP endpoint; {@code /v1/logs}, {@code /v1/traces} and {@code /v1/metrics} are appended. */
    public Builder endpoint(String endpoint) {
      this.endpoint = endpoint;
      return this;
    }

    /** {@code service.name}. Defaults to {@code OTEL_SERVICE_NAME}, then {@code java}. */
    public Builder serviceName(String serviceName) {
      this.serviceName = serviceName;
      return this;
    }

    /** {@code service.version}. */
    public Builder release(String release) {
      this.release = release;
      return this;
    }

    /** {@code deployment.environment.name}. */
    public Builder environment(String environment) {
      this.environment = environment;
      return this;
    }

    /** Share of traces to keep, from 0 to 1. */
    public Builder tracesSampleRate(double tracesSampleRate) {
      this.tracesSampleRate = Math.max(0, Math.min(1, tracesSampleRate));
      return this;
    }

    public Builder beforeSend(BeforeSendCallback beforeSend) {
      this.beforeSend = beforeSend;
      return this;
    }

    public Builder maxEventsPerMinute(int maxEventsPerMinute) {
      this.maxEventsPerMinute = Math.max(0, maxEventsPerMinute);
      return this;
    }

    /** False keeps the SDK quiet, for tests and local development. */
    public Builder enabled(boolean enabled) {
      this.enabled = enabled;
      return this;
    }

    /** Logs why events are dropped. */
    public Builder debug(boolean debug) {
      this.debug = debug;
      return this;
    }

    /** The lowest {@code java.util.logging} level sent to Logs; {@code Level.OFF} turns the bridge off. */
    public Builder loggingLevel(java.util.logging.Level loggingLevel) {
      if (loggingLevel != null) this.loggingLevel = loggingLevel;
      return this;
    }

    public Builder metricsExportInterval(Duration metricsExportInterval) {
      if (metricsExportInterval != null) this.metricsExportInterval = metricsExportInterval;
      return this;
    }

    /** How long the exit and uncaught exception handlers wait for queued data. */
    public Builder shutdownTimeout(Duration shutdownTimeout) {
      if (shutdownTimeout != null) this.shutdownTimeout = shutdownTimeout;
      return this;
    }

    public Builder addSpanProcessor(SpanProcessor spanProcessor) {
      if (spanProcessor != null) spanProcessors.add(spanProcessor);
      return this;
    }

    public Builder addLogRecordProcessor(LogRecordProcessor logRecordProcessor) {
      if (logRecordProcessor != null) logRecordProcessors.add(logRecordProcessor);
      return this;
    }

    Builder environmentVariables(Map<String, String> environmentVariables) {
      this.environmentVariables = environmentVariables;
      return this;
    }

    public InstatusOptions build() {
      return new InstatusOptions(this);
    }
  }
}
