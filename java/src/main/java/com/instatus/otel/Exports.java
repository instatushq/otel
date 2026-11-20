package com.instatus.otel;

import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class Exports {
  static final String DEFAULT_ENDPOINT = "https://otel.instatus.com";

  enum Signal {
    LOGS,
    TRACES,
    METRICS;

    String path() {
      return name().toLowerCase(Locale.ROOT);
    }

    String envSuffix() {
      return name();
    }
  }

  static final class Target {
    final String url;
    final Map<String, String> headers;

    Target(String url, Map<String, String> headers) {
      this.url = url;
      this.headers = Collections.unmodifiableMap(headers);
    }
  }

  private Exports() {}

  // An API key sends every signal to the collector, or to endpoint. Without one, endpoint or the
  // standard OTEL_EXPORTER_OTLP_* variables decide, signal by signal.
  static Map<Signal, Target> resolve(InstatusOptions options, Map<String, String> env) {
    String apiKey = firstPresent(options.getApiKey(), env.get("INSTATUS_API_KEY"));
    String siteId = firstPresent(options.getSiteId(), env.get("INSTATUS_SITE_ID"));
    String endpoint = present(options.getEndpoint());
    Map<Signal, Target> exports = new EnumMap<>(Signal.class);
    for (Signal signal : Signal.values()) {
      Target target = targetFor(signal, apiKey, siteId, endpoint, env);
      if (target != null) exports.put(signal, target);
    }
    return exports;
  }

  private static Target targetFor(Signal signal, String apiKey, String siteId, String endpoint, Map<String, String> env) {
    if (apiKey != null) {
      Map<String, String> headers = new LinkedHashMap<>();
      headers.put("Authorization", "Bearer " + apiKey);
      if (siteId != null) headers.put("X-Instatus-Site-Id", siteId);
      return new Target(urlFor(signal, endpoint, env, DEFAULT_ENDPOINT), headers);
    }
    String url = urlFor(signal, endpoint, env, null);
    if (url == null) return null;
    return new Target(url, envHeaders(signal, env));
  }

  private static String urlFor(Signal signal, String endpoint, Map<String, String> env, String fallback) {
    if (endpoint != null) return signalUrl(endpoint, signal);
    String signalEndpoint = present(env.get("OTEL_EXPORTER_OTLP_" + signal.envSuffix() + "_ENDPOINT"));
    if (signalEndpoint != null) return signalEndpoint;
    String sharedEndpoint = present(env.get("OTEL_EXPORTER_OTLP_ENDPOINT"));
    if (sharedEndpoint != null) return signalUrl(sharedEndpoint, signal);
    if (fallback == null) return null;
    return signalUrl(fallback, signal);
  }

  static String signalUrl(String endpoint, Signal signal) {
    return endpoint.replaceAll("/+$", "") + "/v1/" + signal.path();
  }

  private static Map<String, String> envHeaders(Signal signal, Map<String, String> env) {
    Map<String, String> headers = KeyValueList.parse(env.get("OTEL_EXPORTER_OTLP_HEADERS"));
    headers.putAll(KeyValueList.parse(env.get("OTEL_EXPORTER_OTLP_" + signal.envSuffix() + "_HEADERS")));
    return headers;
  }

  private static String present(String value) {
    if (value == null || value.isBlank()) return null;
    return value.trim();
  }

  private static String firstPresent(String option, String fromEnv) {
    String value = present(option);
    return value != null ? value : present(fromEnv);
  }
}
