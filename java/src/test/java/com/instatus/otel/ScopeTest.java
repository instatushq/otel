package com.instatus.otel;

import static com.instatus.otel.Recorder.string;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import java.util.Map;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ScopeTest {
  private Recorder recorder;

  @BeforeEach
  void start() {
    recorder = Recorder.start();
  }

  @AfterEach
  void stop() {
    recorder.close();
  }

  private Map<String, LogRecordData> logsByBody() {
    return recorder.logs().stream()
        .collect(Collectors.toMap(record -> record.getBodyValue().asString(), Function.identity()));
  }

  @Test
  void keepsWithScopeChangesInside() {
    Instatus.setTag("plan", "pro");
    Instatus.withScope(
        scope -> {
          scope.setTag("job", "invoice");
          Instatus.setTag("step", "charge");
          Instatus.captureMessage("inside");
        });
    Instatus.captureMessage("outside");
    Map<String, LogRecordData> logs = logsByBody();
    assertEquals("pro", string(logs.get("inside"), "plan"));
    assertEquals("invoice", string(logs.get("inside"), "job"));
    assertEquals("charge", string(logs.get("inside"), "step"));
    assertEquals("pro", string(logs.get("outside"), "plan"));
    assertNull(string(logs.get("outside"), "job"));
    assertNull(string(logs.get("outside"), "step"));
  }

  @Test
  void isolatesThreads() throws Exception {
    CyclicBarrier bothInside = new CyclicBarrier(2);
    Runnable ada = () -> request("ada", bothInside);
    Runnable bob = () -> request("bob", bothInside);
    Thread first = new Thread(ada);
    Thread second = new Thread(bob);
    first.start();
    second.start();
    first.join(5000);
    second.join(5000);
    Map<String, LogRecordData> logs = logsByBody();
    assertEquals("ada", string(logs.get("request ada"), "enduser.id"));
    assertEquals("ada", string(logs.get("request ada"), "request"));
    assertEquals("bob", string(logs.get("request bob"), "enduser.id"));
    assertEquals("bob", string(logs.get("request bob"), "request"));
  }

  private static void request(String name, CyclicBarrier bothInside) {
    Instatus.withScope(
        scope -> {
          Instatus.setUser(new User().setId(name));
          Instatus.setTag("request", name);
          await(bothInside);
          Instatus.captureMessage("request " + name);
        });
  }

  private static void await(CyclicBarrier barrier) {
    try {
      barrier.await(5, TimeUnit.SECONDS);
    } catch (Exception failure) {
      throw new IllegalStateException(failure);
    }
  }

  @Test
  void keepsThreadScopesApart() throws Exception {
    Thread other = new Thread(() -> Instatus.setTag("from", "other thread"));
    other.start();
    other.join(5000);
    Instatus.captureMessage("main");
    assertNull(string(recorder.onlyLog(), "from"));
  }

  @Test
  void appliesTheGlobalScopeOnEveryThread() throws Exception {
    Instatus.getGlobalScope().setTag("region", "eu");
    Thread other = new Thread(() -> Instatus.captureMessage("worker"));
    other.start();
    other.join(5000);
    assertEquals("eu", string(recorder.onlyLog(), "region"));
  }

  @Test
  void followsTheContextToOtherThreads() throws Exception {
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try {
      Instatus.withScope(
          scope -> {
            scope.setTag("job", "export");
            executor.submit(Context.current().wrap(() -> Instatus.captureMessage("async")));
          });
      executor.shutdown();
      executor.awaitTermination(5, TimeUnit.SECONDS);
    } finally {
      executor.shutdownNow();
    }
    assertEquals("export", string(recorder.onlyLog(), "job"));
  }

  @Test
  void appliesCaptureChangesToOneEvent() {
    Instatus.captureException(new IllegalStateException("first"), scope -> scope.setTag("step", "charge"));
    Instatus.captureException(new IllegalStateException("second"));
    Map<String, LogRecordData> logs = logsByBody();
    assertEquals("charge", string(logs.get("java.lang.IllegalStateException: first"), "step"));
    assertNull(string(logs.get("java.lang.IllegalStateException: second"), "step"));
  }

  @Test
  void setsContextsAndExtras() {
    Instatus.setContext("cart", Map.of("items", 3));
    Instatus.setExtra("retry", "2");
    Instatus.setTags(Map.of("a", "1", "b", "2"));
    Instatus.captureMessage("with metadata", Level.WARNING);
    LogRecordData record = recorder.onlyLog();
    assertEquals(3L, record.getAttributes().get(io.opentelemetry.api.common.AttributeKey.longKey("cart.items")));
    assertEquals("2", string(record, "extra.retry"));
    assertEquals("1", string(record, "a"));
    assertEquals(io.opentelemetry.api.logs.Severity.WARN, record.getSeverity());
  }
}
