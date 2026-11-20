package com.instatus.otel;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

final class Recorder implements AutoCloseable {
  private final InMemoryLogRecordExporter logs = InMemoryLogRecordExporter.create();
  private final InMemorySpanExporter spans = InMemorySpanExporter.create();

  static Recorder start() {
    return start(options -> {});
  }

  static Recorder start(Consumer<InstatusOptions.Builder> configure) {
    Recorder recorder = new Recorder();
    InstatusOptions.Builder builder =
        InstatusOptions.builder()
            .environmentVariables(Map.of())
            .loggingLevel(java.util.logging.Level.OFF)
            .addLogRecordProcessor(SimpleLogRecordProcessor.create(recorder.logs))
            .addSpanProcessor(SimpleSpanProcessor.create(recorder.spans));
    configure.accept(builder);
    Instatus.init(builder.build());
    return recorder;
  }

  List<LogRecordData> logs() {
    return logs.getFinishedLogRecordItems();
  }

  LogRecordData onlyLog() {
    List<LogRecordData> all = logs();
    if (all.size() != 1) throw new AssertionError("expected one log record, got " + all.size());
    return all.get(0);
  }

  List<SpanData> spans() {
    return spans.getFinishedSpanItems();
  }

  static String string(LogRecordData record, String key) {
    return record.getAttributes().get(AttributeKey.stringKey(key));
  }

  static Boolean bool(LogRecordData record, String key) {
    return record.getAttributes().get(AttributeKey.booleanKey(key));
  }

  @Override
  public void close() {
    Instatus.close(Duration.ofSeconds(5));
    Instatus.getCurrentScope().clear();
    Instatus.getGlobalScope().clear();
    GlobalOpenTelemetry.resetForTest();
  }
}
