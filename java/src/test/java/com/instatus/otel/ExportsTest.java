package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.instatus.otel.Exports.Signal;
import com.instatus.otel.Exports.Target;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ExportsTest {
  private static Map<Signal, Target> resolve(InstatusOptions.Builder options, Map<String, String> env) {
    return Exports.resolve(options.build(), env);
  }

  @Test
  void sendsEverySignalToTheCollectorWithAnApiKey() {
    Map<Signal, Target> exports = resolve(InstatusOptions.builder().apiKey("sk_test").siteId("site_1"), Map.of());
    assertEquals(3, exports.size());
    assertEquals("https://otel.instatus.com/v1/logs", exports.get(Signal.LOGS).url);
    assertEquals("https://otel.instatus.com/v1/traces", exports.get(Signal.TRACES).url);
    assertEquals("https://otel.instatus.com/v1/metrics", exports.get(Signal.METRICS).url);
    assertEquals(
        Map.of("Authorization", "Bearer sk_test", "X-Instatus-Site-Id", "site_1"), exports.get(Signal.LOGS).headers);
  }

  @Test
  void readsTheKeyAndSiteFromTheEnvironment() {
    Map<Signal, Target> exports =
        resolve(InstatusOptions.builder(), Map.of("INSTATUS_API_KEY", "sk_env", "INSTATUS_SITE_ID", "site_env"));
    assertEquals(
        Map.of("Authorization", "Bearer sk_env", "X-Instatus-Site-Id", "site_env"), exports.get(Signal.TRACES).headers);
  }

  @Test
  void leavesTheSiteHeaderOutWithoutASiteId() {
    Map<Signal, Target> exports = resolve(InstatusOptions.builder().apiKey("sk_test"), Map.of());
    assertEquals(Map.of("Authorization", "Bearer sk_test"), exports.get(Signal.LOGS).headers);
  }

  @Test
  void appendsTheSignalPathToEndpoint() {
    Map<Signal, Target> exports =
        resolve(InstatusOptions.builder().apiKey("sk_test").endpoint("http://localhost:4318/"), Map.of());
    assertEquals("http://localhost:4318/v1/logs", exports.get(Signal.LOGS).url);
  }

  @Test
  void endpointWinsOverTheEnvironment() {
    Map<Signal, Target> exports =
        resolve(
            InstatusOptions.builder().endpoint("http://collector:4318"),
            Map.of("OTEL_EXPORTER_OTLP_ENDPOINT", "http://other:4318"));
    assertEquals("http://collector:4318/v1/traces", exports.get(Signal.TRACES).url);
  }

  @Test
  void usesTheOtlpEnvironmentEndpointWithAnApiKey() {
    Map<Signal, Target> exports =
        resolve(
            InstatusOptions.builder().apiKey("sk_test"),
            Map.of(
                "OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318",
                "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "http://logs:4318/custom"));
    assertEquals("http://logs:4318/custom", exports.get(Signal.LOGS).url);
    assertEquals("http://collector:4318/v1/traces", exports.get(Signal.TRACES).url);
  }

  @Test
  void followsTheOtlpEnvironmentWithoutAKey() {
    Map<Signal, Target> exports =
        resolve(
            InstatusOptions.builder(),
            Map.of(
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://traces:4318/v1/traces",
                "OTEL_EXPORTER_OTLP_HEADERS", "x-team=core,authorization=Basic%20abc"));
    assertEquals(1, exports.size());
    assertEquals("http://traces:4318/v1/traces", exports.get(Signal.TRACES).url);
    assertEquals(Map.of("x-team", "core", "authorization", "Basic abc"), exports.get(Signal.TRACES).headers);
  }

  @Test
  void exportsNothingWithoutConfiguration() {
    assertTrue(resolve(InstatusOptions.builder(), Map.of()).isEmpty());
  }

  @Test
  void ignoresBlankValues() {
    assertTrue(resolve(InstatusOptions.builder().apiKey(" "), Map.of("INSTATUS_API_KEY", "")).isEmpty());
  }
}
