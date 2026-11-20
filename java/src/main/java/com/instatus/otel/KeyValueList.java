package com.instatus.otel;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

// The comma-separated key=value format of OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES.
final class KeyValueList {
  private KeyValueList() {}

  static Map<String, String> parse(String raw) {
    Map<String, String> values = new LinkedHashMap<>();
    if (raw == null || raw.isBlank()) return values;
    for (String part : raw.split(",")) {
      int separator = part.indexOf('=');
      if (separator <= 0) continue;
      String key = decode(part.substring(0, separator).trim());
      if (!key.isEmpty()) values.put(key, decode(part.substring(separator + 1).trim()));
    }
    return values;
  }

  private static String decode(String value) {
    try {
      return URLDecoder.decode(value, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException malformed) {
      return value;
    }
  }
}
