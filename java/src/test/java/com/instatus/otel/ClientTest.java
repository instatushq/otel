package com.instatus.otel;

import static com.instatus.otel.Recorder.bool;
import static com.instatus.otel.Recorder.string;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class ClientTest {
  private Recorder recorder;

  @AfterEach
  void stop() {
    if (recorder != null) recorder.close();
  }

  private static IllegalStateException sameError() {
    return new IllegalStateException("payment failed");
  }

  @Test
  void sendsTwoIdenticalErrorsInARowOnce() {
    recorder = Recorder.start();
    List<IllegalStateException> errors = new ArrayList<>();
    for (int index = 0; index < 3; index++) errors.add(sameError());
    Instatus.captureException(errors.get(0));
    Instatus.captureException(errors.get(1));
    Instatus.captureException(new IllegalArgumentException("other"));
    Instatus.captureException(errors.get(2));
    assertEquals(3, recorder.logs().size());
  }

  @Test
  void sendsOneErrorOnceEvenWhenCapturedAgain() {
    recorder = Recorder.start();
    IllegalStateException error = new IllegalStateException("once");
    String first = Instatus.captureException(error);
    Instatus.captureMessage("between");
    Instatus.captureException(error);
    assertEquals(2, recorder.logs().size());
    assertTrue(first.matches("[0-9a-f]{32}"));
  }

  @Test
  void capsErrorsPerMinute() {
    recorder = Recorder.start(options -> options.maxEventsPerMinute(2));
    for (int index = 0; index < 5; index++) Instatus.captureMessage("message " + index, Level.ERROR);
    assertEquals(2, recorder.logs().size());
  }

  @Test
  void letsBeforeSendChangeOrDropEvents() {
    recorder =
        Recorder.start(
            options ->
                options.beforeSend(
                    event -> {
                      if ("drop me".equals(event.getMessage())) return null;
                      event.getTags().put("checked", "yes");
                      return event;
                    }));
    Instatus.captureMessage("drop me");
    Instatus.captureMessage("keep me");
    LogRecordData record = recorder.onlyLog();
    assertEquals("keep me", record.getBodyValue().asString());
    assertEquals("yes", string(record, "checked"));
  }

  @Test
  void dropsTheEventWhenBeforeSendThrows() {
    recorder =
        Recorder.start(
            options ->
                options.beforeSend(
                    event -> {
                      throw new IllegalStateException("broken hook");
                    }));
    Instatus.captureMessage("lost");
    assertTrue(recorder.logs().isEmpty());
  }

  @Test
  void handsBeforeSendTheThrowableAndRelease() {
    AtomicReference<Event> seen = new AtomicReference<>();
    recorder =
        Recorder.start(
            options ->
                options
                    .release("api@1.4.0")
                    .environment("staging")
                    .beforeSend(
                        event -> {
                          seen.set(event);
                          return event;
                        }));
    IllegalStateException error = new IllegalStateException("boom");
    Instatus.captureException(error);
    assertSame(error, seen.get().getThrowable());
    assertEquals("api@1.4.0", seen.get().getRelease());
    assertEquals("staging", seen.get().getEnvironment());
    assertEquals(Boolean.TRUE, seen.get().getHandled());
  }

  @Test
  void sendsNothingWhenDisabled() {
    recorder = Recorder.start(options -> options.enabled(false));
    Instatus.captureException(new IllegalStateException("quiet"));
    assertTrue(recorder.logs().isEmpty());
    assertEquals("value", Instatus.startSpan("still runs", () -> "value"));
  }

  @Test
  void doesNothingBeforeInit() {
    assertTrue(Instatus.captureException(new IllegalStateException("early")).matches("[0-9a-f]{32}"));
    assertEquals(4, (int) Instatus.startSpan("no sdk", () -> 4));
    assertTrue(Instatus.flush(null));
  }

  @Test
  void recordsErrorsOnTheActiveSpan() {
    recorder = Recorder.start();
    Instatus.startSpan(
        "checkout",
        () -> {
          Instatus.setUser(new User().setId("42"));
          Instatus.captureException(new IllegalStateException("card declined"));
        });
    SpanData span = recorder.spans().get(0);
    LogRecordData record = recorder.onlyLog();
    assertEquals(span.getTraceId(), record.getSpanContext().getTraceId());
    assertEquals(span.getSpanId(), record.getSpanContext().getSpanId());
    assertEquals(StatusCode.UNSET, span.getStatus().getStatusCode());
    assertEquals("42", span.getAttributes().get(io.opentelemetry.api.common.AttributeKey.stringKey("enduser.id")));
    EventData event = span.getEvents().get(0);
    assertEquals("exception", event.getName());
    assertEquals(
        "java.lang.IllegalStateException",
        event.getAttributes().get(io.opentelemetry.api.common.AttributeKey.stringKey("exception.type")));
  }

  @Test
  void marksAFailedSpan() {
    recorder = Recorder.start();
    assertThrows(
        IllegalStateException.class,
        () ->
            Instatus.startSpan(
                "sync",
                () -> {
                  throw new IllegalStateException("upstream down");
                }));
    SpanData span = recorder.spans().get(0);
    assertEquals("sync", span.getName());
    assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
    assertEquals("upstream down", span.getStatus().getDescription());
    assertTrue(span.hasEnded());
  }

  @Test
  void filtersCardNumbersOutOfTheFailedSpanStatus() {
    recorder = Recorder.start();
    assertThrows(
        IllegalStateException.class,
        () ->
            Instatus.startSpan(
                "charge",
                () -> {
                  throw new IllegalStateException("card 4111 1111 1111 1111 declined");
                }));
    SpanData span = recorder.spans().get(0);
    assertEquals("card [Filtered] declined", span.getStatus().getDescription());
    assertTrue(span.getEvents().isEmpty());
  }

  @Test
  void reportsUncaughtExceptionsAndChainsThePreviousHandler() throws Exception {
    Thread.UncaughtExceptionHandler original = Thread.getDefaultUncaughtExceptionHandler();
    AtomicReference<Throwable> passedOn = new AtomicReference<>();
    Thread.UncaughtExceptionHandler previous = (thread, error) -> passedOn.set(error);
    Thread.setDefaultUncaughtExceptionHandler(previous);
    try {
      recorder = Recorder.start();
      IllegalStateException crash = new IllegalStateException("worker crashed");
      Thread worker =
          new Thread(
              () -> {
                throw crash;
              });
      worker.start();
      worker.join(5000);
      LogRecordData record = recorder.onlyLog();
      assertEquals(Severity.FATAL, record.getSeverity());
      assertEquals(Boolean.FALSE, bool(record, "exception.handled"));
      assertSame(crash, passedOn.get());
      recorder.close();
      recorder = null;
      assertSame(previous, Thread.getDefaultUncaughtExceptionHandler());
    } finally {
      Thread.setDefaultUncaughtExceptionHandler(original);
    }
  }

  @Test
  void skipsUncaughtErrorsThatWereAlreadyCaptured() throws Exception {
    Thread.UncaughtExceptionHandler original = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {});
    try {
      recorder = Recorder.start();
      Thread worker =
          new Thread(
              () -> {
                IllegalStateException error = new IllegalStateException("rethrown");
                Instatus.captureException(error);
                throw error;
              });
      worker.start();
      worker.join(5000);
      assertEquals(Boolean.TRUE, bool(recorder.onlyLog(), "exception.handled"));
    } finally {
      Thread.setDefaultUncaughtExceptionHandler(original);
    }
  }

  @Test
  void ignoresASecondInit() {
    recorder = Recorder.start();
    Instatus.init(options -> options.enabled(false));
    Instatus.captureMessage("still enabled");
    assertEquals(1, recorder.logs().size());
    assertNull(string(recorder.onlyLog(), "exception.type"));
  }
}
