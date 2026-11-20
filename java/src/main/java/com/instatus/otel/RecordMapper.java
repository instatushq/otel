package com.instatus.otel;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.LinkedHashMap;
import java.util.Map;

final class RecordMapper {
  static final int MAX_VALUE_LENGTH = 8192;
  static final int MAX_STACK_LENGTH = 32_000;
  static final int MAX_ATTRIBUTES = 128;
  static final String DEFAULT_EXCEPTION_TYPE = "Error";

  private static final String RESERVED_PREFIX = "instatus.";
  private static final Map<String, String> USER_KEYS = Map.of("username", "name", "ip_address", "ip");

  private RecordMapper() {}

  // The error's own fields come first and win: receivers cap attribute counts, and metadata must
  // never push the exception out.
  static ErrorLogRecord toLogRecord(Event event) {
    Map<String, Object> attributes = exceptionAttributes(event);
    attributes.put("log.record.uid", event.getEventId());
    putUrl(attributes, event.getRequestUrl());
    for (Map.Entry<String, Object> entry : metadataOf(event).entrySet()) {
      if (attributes.size() >= MAX_ATTRIBUTES) break;
      attributes.putIfAbsent(entry.getKey(), entry.getValue());
    }
    return new ErrorLogRecord(event.getTimestamp(), event.getLevel(), bodyOf(event), attributes);
  }

  static Object toAttributeValue(Object value) {
    if (value == null) return null;
    if (value instanceof String) return truncate((String) value, MAX_VALUE_LENGTH);
    if (value instanceof Boolean) return value;
    if (value instanceof Long || value instanceof Integer || value instanceof Short || value instanceof Byte) {
      return ((Number) value).longValue();
    }
    if (value instanceof Double || value instanceof Float) return ((Number) value).doubleValue();
    if (value instanceof BigInteger || value instanceof BigDecimal) return value.toString();
    if (value instanceof Map || value instanceof Iterable) {
      return truncate(Json.write(value), MAX_VALUE_LENGTH);
    }
    return truncate(readable(value), MAX_VALUE_LENGTH);
  }

  static String truncate(String text, int limit) {
    if (text == null || text.length() <= limit) return text;
    int end = Character.isHighSurrogate(text.charAt(limit - 1)) ? limit - 1 : limit;
    return text.substring(0, end);
  }

  private static String readable(Object value) {
    try {
      return String.valueOf(value);
    } catch (RuntimeException unreadable) {
      return Scrubber.UNREADABLE;
    }
  }

  private static Map<String, Object> exceptionAttributes(Event event) {
    Map<String, Object> attributes = new LinkedHashMap<>();
    if (event.hasException()) {
      attributes.put("exception.type", exceptionTypeOf(event));
      attributes.put("exception.message", truncate(scrubbed(event.getExceptionMessage()), MAX_VALUE_LENGTH));
      if (event.getStacktrace() != null) {
        attributes.put("exception.stacktrace", truncate(Scrubber.scrubText(event.getStacktrace()), MAX_STACK_LENGTH));
      }
      if (event.getHandled() != null) attributes.put("exception.handled", event.getHandled());
      return attributes;
    }
    String message = event.getMessage();
    if (event.getLevel().isError() && message != null && !message.isEmpty()) {
      attributes.put("exception.type", DEFAULT_EXCEPTION_TYPE);
      attributes.put("exception.message", truncate(Scrubber.scrubText(message), MAX_VALUE_LENGTH));
    }
    return attributes;
  }

  private static String exceptionTypeOf(Event event) {
    String type = event.getExceptionType();
    return type == null || type.isEmpty() ? DEFAULT_EXCEPTION_TYPE : type;
  }

  private static String scrubbed(String text) {
    return text == null ? "" : Scrubber.scrubText(text);
  }

  private static String bodyOf(Event event) {
    if (!event.hasException()) return scrubbed(event.getMessage());
    String type = exceptionTypeOf(event);
    String message = scrubbed(event.getExceptionMessage());
    return message.isEmpty() ? type : type + ": " + message;
  }

  private static void putUrl(Map<String, Object> attributes, String requestUrl) {
    if (requestUrl == null || requestUrl.isEmpty()) return;
    String url = Scrubber.scrubUrl(requestUrl);
    attributes.put("url.full", truncate(url, MAX_VALUE_LENGTH));
    String path = pathOf(url);
    if (path != null) attributes.put("url.path", path);
  }

  private static String pathOf(String url) {
    try {
      URI uri = new URI(url);
      if (!uri.isAbsolute()) return null;
      String path = uri.getRawPath();
      if (path == null) return null;
      return path.isEmpty() ? "/" : path;
    } catch (URISyntaxException invalid) {
      return null;
    }
  }

  private static void put(Map<String, Object> attributes, String key, Object value) {
    if (key.startsWith(RESERVED_PREFIX)) return;
    Object attribute = toAttributeValue(Scrubber.scrubValue(key, value));
    if (attribute == null || "".equals(attribute)) return;
    attributes.put(key, attribute);
  }

  private static Map<String, Object> metadataOf(Event event) {
    Map<String, Object> metadata = new LinkedHashMap<>();
    event.getTags().forEach((key, value) -> put(metadata, key, value));
    event.getContexts().forEach((name, context) -> context.forEach((key, value) -> put(metadata, name + "." + key, value)));
    event.getExtra().forEach((key, value) -> put(metadata, "extra." + key, value));
    metadata.putAll(userAttributes(event.getUser()));
    return metadata;
  }

  private static Map<String, Object> userAttributes(User user) {
    Map<String, Object> attributes = new LinkedHashMap<>();
    if (user == null) return attributes;
    String endUserId = user.endUserId();
    if (endUserId != null) attributes.put("enduser.id", endUserId);
    user.fields().forEach((key, value) -> put(attributes, "user." + USER_KEYS.getOrDefault(key, key), value));
    return attributes;
  }
}
