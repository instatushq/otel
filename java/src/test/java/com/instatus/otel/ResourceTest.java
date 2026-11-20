package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.resources.Resource;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ResourceTest {
  private static String attribute(Resource resource, String key) {
    return resource.getAttribute(AttributeKey.stringKey(key));
  }

  private static Resource build(InstatusOptions.Builder options, Map<String, String> env) {
    return InstatusResource.build(options.build(), env);
  }

  @Test
  void describesTheSdkAndRelease() {
    Resource resource = build(InstatusOptions.builder().release("api@1.4.0").environment("production"), Map.of());
    assertEquals("com.instatus:instatus-otel", attribute(resource, "telemetry.sdk.name"));
    assertEquals(Version.VERSION, attribute(resource, "telemetry.sdk.version"));
    assertEquals("java", attribute(resource, "telemetry.sdk.language"));
    assertEquals("api@1.4.0", attribute(resource, "service.version"));
    assertEquals("production", attribute(resource, "deployment.environment.name"));
  }

  @Test
  void picksTheServiceName() {
    Map<String, String> env =
        Map.of("OTEL_SERVICE_NAME", "from-env", "OTEL_RESOURCE_ATTRIBUTES", "service.name=from-attributes");
    assertEquals("checkout", attribute(build(InstatusOptions.builder().serviceName("checkout"), env), "service.name"));
    assertEquals("from-env", attribute(build(InstatusOptions.builder(), env), "service.name"));
    assertEquals(
        "from-attributes",
        attribute(
            build(InstatusOptions.builder(), Map.of("OTEL_RESOURCE_ATTRIBUTES", "service.name=from-attributes")),
            "service.name"));
    assertEquals("java", attribute(build(InstatusOptions.builder(), Map.of()), "service.name"));
  }

  @Test
  void honoursOtelResourceAttributes() {
    Resource resource =
        build(InstatusOptions.builder(), Map.of("OTEL_RESOURCE_ATTRIBUTES", "team=payments,region=eu%2Dwest"));
    assertEquals("payments", attribute(resource, "team"));
    assertEquals("eu-west", attribute(resource, "region"));
  }

  @Test
  void detectsTheHostAndProcess() {
    Resource resource = build(InstatusOptions.builder(), Map.of());
    assertNotNull(attribute(resource, "host.name"));
    assertNotNull(resource.getAttribute(AttributeKey.longKey("process.pid")));
    assertNotNull(attribute(resource, "process.runtime.name"));
    assertNotNull(attribute(resource, "os.type"));
    assertNull(attribute(resource, "process.command_line"));
    assertNull(resource.getAttribute(AttributeKey.stringArrayKey("process.command_args")));
  }
}
