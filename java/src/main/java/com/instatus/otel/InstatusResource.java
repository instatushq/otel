package com.instatus.otel;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.instrumentation.resources.HostResource;
import io.opentelemetry.instrumentation.resources.OsResource;
import io.opentelemetry.instrumentation.resources.ProcessResource;
import io.opentelemetry.instrumentation.resources.ProcessRuntimeResource;
import io.opentelemetry.sdk.resources.Resource;
import java.util.Map;

final class InstatusResource {
  static final String LANGUAGE = "java";
  static final String FALLBACK_SERVICE_NAME = "java";

  private static final AttributeKey<String> SERVICE_NAME = AttributeKey.stringKey("service.name");

  private InstatusResource() {}

  static Resource build(InstatusOptions options, Map<String, String> env) {
    Resource fromEnv = Resource.create(toAttributes(KeyValueList.parse(env.get("OTEL_RESOURCE_ATTRIBUTES"))));
    return detected().merge(fromEnv).merge(Resource.create(instatusAttributes(options, env, fromEnv)));
  }

  // ProcessResource.create() leaves the command line out: JVM flags often carry secrets
  // (-Djavax.net.ssl.keyStorePassword=...), and every record carries the resource.
  static Resource detected() {
    return Resource.getDefault()
        .merge(HostResource.get())
        .merge(OsResource.get())
        .merge(ProcessResource.create())
        .merge(ProcessRuntimeResource.get());
  }

  static Attributes instatusAttributes(InstatusOptions options, Map<String, String> env, Resource fromEnv) {
    AttributesBuilder attributes =
        Attributes.builder()
            .put(SERVICE_NAME, serviceName(options, env, fromEnv))
            .put("telemetry.sdk.name", Version.SDK_NAME)
            .put("telemetry.sdk.version", Version.VERSION)
            .put("telemetry.sdk.language", LANGUAGE);
    if (isPresent(options.getRelease())) attributes.put("service.version", options.getRelease());
    if (isPresent(options.getEnvironment())) attributes.put("deployment.environment.name", options.getEnvironment());
    return attributes.build();
  }

  private static String serviceName(InstatusOptions options, Map<String, String> env, Resource fromEnv) {
    if (isPresent(options.getServiceName())) return options.getServiceName();
    String fromServiceEnv = env.get("OTEL_SERVICE_NAME");
    if (isPresent(fromServiceEnv)) return fromServiceEnv;
    String fromResourceEnv = fromEnv.getAttribute(SERVICE_NAME);
    if (isPresent(fromResourceEnv)) return fromResourceEnv;
    return FALLBACK_SERVICE_NAME;
  }

  private static Attributes toAttributes(Map<String, String> values) {
    AttributesBuilder attributes = Attributes.builder();
    values.forEach(attributes::put);
    return attributes.build();
  }

  private static boolean isPresent(String value) {
    return value != null && !value.isBlank();
  }
}
