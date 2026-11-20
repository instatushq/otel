package com.instatus.otel;

import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.logs.Severity;
import java.util.List;
import java.util.logging.ErrorManager;
import java.util.logging.Formatter;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.logging.SimpleFormatter;

/**
 * Sends {@code java.util.logging} records to Logs. {@link Instatus#init} adds one to the root
 * logger; add it to {@code logging.properties} yourself when you set up logging there.
 */
public final class InstatusLogHandler extends Handler {
  private static final ThreadLocal<Boolean> EMITTING = ThreadLocal.withInitial(() -> false);
  private static final Formatter MESSAGE_FORMATTER = new SimpleFormatter();
  // The SDK's own warnings, and the HTTP client the exporter uses, would loop back into exports.
  private static final List<String> INTERNAL_LOGGERS =
      List.of("io.opentelemetry", "com.instatus.otel", "jdk.internal.httpclient");
  private static final String ROOT_LOGGER_NAME = "ROOT";

  @Override
  public void publish(LogRecord record) {
    if (record == null || !isLoggable(record) || isInternal(record.getLoggerName()) || EMITTING.get()) return;
    EMITTING.set(true);
    try {
      emit(record);
    } catch (RuntimeException failure) {
      reportError("Could not send a log record to Instatus", failure, ErrorManager.WRITE_FAILURE);
    } finally {
      EMITTING.set(false);
    }
  }

  @Override
  public void flush() {}

  @Override
  public void close() {}

  private static void emit(LogRecord record) {
    Instatus.getOpenTelemetry()
        .getLogsBridge()
        .get(loggerName(record))
        .logRecordBuilder()
        .setTimestamp(record.getInstant())
        .setSeverity(severityOf(record.getLevel()))
        .setSeverityText(record.getLevel().getName())
        .setBody(Scrubber.scrubText(MESSAGE_FORMATTER.formatMessage(record)))
        .setAllAttributes(attributesOf(record))
        .emit();
  }

  private static String loggerName(LogRecord record) {
    String name = record.getLoggerName();
    if (name == null || name.isEmpty()) return ROOT_LOGGER_NAME;
    return name;
  }

  private static boolean isInternal(String loggerName) {
    if (loggerName == null) return false;
    return INTERNAL_LOGGERS.stream().anyMatch(loggerName::startsWith);
  }

  private static Attributes attributesOf(LogRecord record) {
    Thread thread = Thread.currentThread();
    AttributesBuilder attributes =
        Attributes.builder().put("thread.name", thread.getName()).put("thread.id", thread.getId());
    Throwable thrown = record.getThrown();
    if (thrown == null) return attributes.build();
    Event event = Event.fromThrowable(thrown, true);
    attributes.put("exception.type", event.getExceptionType());
    attributes.put(
        "exception.message",
        RecordMapper.truncate(Scrubber.scrubText(event.getExceptionMessage()), RecordMapper.MAX_VALUE_LENGTH));
    if (event.getStacktrace() != null) {
      attributes.put(
          "exception.stacktrace",
          RecordMapper.truncate(Scrubber.scrubText(event.getStacktrace()), RecordMapper.MAX_STACK_LENGTH));
    }
    return attributes.build();
  }

  static Severity severityOf(java.util.logging.Level level) {
    int value = level.intValue();
    if (value >= java.util.logging.Level.SEVERE.intValue()) return Severity.ERROR;
    if (value >= java.util.logging.Level.WARNING.intValue()) return Severity.WARN;
    if (value >= java.util.logging.Level.INFO.intValue()) return Severity.INFO;
    if (value >= java.util.logging.Level.CONFIG.intValue()) return Severity.DEBUG4;
    if (value >= java.util.logging.Level.FINE.intValue()) return Severity.DEBUG;
    if (value >= java.util.logging.Level.FINER.intValue()) return Severity.TRACE4;
    return Severity.TRACE;
  }
}
