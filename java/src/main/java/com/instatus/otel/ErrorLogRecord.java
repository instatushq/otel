package com.instatus.otel;

import java.time.Instant;
import java.util.Collections;
import java.util.Map;

final class ErrorLogRecord {
  final Instant timestamp;
  final Level level;
  final String body;
  final Map<String, Object> attributes;

  ErrorLogRecord(Instant timestamp, Level level, String body, Map<String, Object> attributes) {
    this.timestamp = timestamp;
    this.level = level;
    this.body = body;
    this.attributes = Collections.unmodifiableMap(attributes);
  }
}
