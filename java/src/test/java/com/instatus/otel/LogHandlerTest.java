package com.instatus.otel;

import static com.instatus.otel.Recorder.string;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import java.util.Arrays;
import java.util.logging.Logger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LogHandlerTest {
  private Recorder recorder;

  @BeforeEach
  void start() {
    recorder = Recorder.start(options -> options.loggingLevel(java.util.logging.Level.INFO));
  }

  @AfterEach
  void stop() {
    recorder.close();
  }

  @Test
  void sendsJavaUtilLoggingRecordsToLogs() {
    Logger logger = Logger.getLogger("com.acme.Checkout");
    logger.log(
        java.util.logging.Level.WARNING,
        "charge failed for {0}",
        new Object[] {"4111 1111 1111 1111"});
    LogRecordData record = recorder.onlyLog();
    assertEquals("charge failed for [Filtered]", record.getBodyValue().asString());
    assertEquals(Severity.WARN, record.getSeverity());
    assertEquals("WARNING", record.getSeverityText());
    assertEquals("com.acme.Checkout", record.getInstrumentationScopeInfo().getName());
  }

  @Test
  void addsTheThrownException() {
    Logger.getLogger("com.acme.Jobs")
        .log(java.util.logging.Level.SEVERE, "job failed", new IllegalStateException("queue gone"));
    LogRecordData record = recorder.onlyLog();
    assertEquals(Severity.ERROR, record.getSeverity());
    assertEquals("java.lang.IllegalStateException", string(record, "exception.type"));
    assertEquals("queue gone", string(record, "exception.message"));
    assertEquals("java", StackLanguage.detect(string(record, "exception.stacktrace")));
  }

  @Test
  void skipsRecordsBelowTheLevelAndTheSdksOwn() {
    Logger debug = Logger.getLogger("com.acme.Debug");
    debug.setLevel(java.util.logging.Level.ALL);
    debug.fine("too detailed");
    Logger.getLogger("io.opentelemetry.exporter.internal.http.HttpExporter").warning("Failed to export");
    assertTrue(recorder.logs().isEmpty());
  }

  @Test
  void leavesTheRootLoggerOnClose() {
    Logger root = Logger.getLogger("");
    assertTrue(Arrays.stream(root.getHandlers()).anyMatch(InstatusLogHandler.class::isInstance));
    Instatus.close(null);
    assertFalse(Arrays.stream(root.getHandlers()).anyMatch(InstatusLogHandler.class::isInstance));
  }

  @Test
  void mapsLevelsToSeverities() {
    assertEquals(Severity.ERROR, InstatusLogHandler.severityOf(java.util.logging.Level.SEVERE));
    assertEquals(Severity.INFO, InstatusLogHandler.severityOf(java.util.logging.Level.INFO));
    assertEquals(Severity.DEBUG4, InstatusLogHandler.severityOf(java.util.logging.Level.CONFIG));
    assertEquals(Severity.DEBUG, InstatusLogHandler.severityOf(java.util.logging.Level.FINE));
    assertEquals(Severity.TRACE, InstatusLogHandler.severityOf(java.util.logging.Level.FINEST));
  }
}
