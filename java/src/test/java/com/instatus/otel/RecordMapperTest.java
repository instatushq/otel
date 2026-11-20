package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RecordMapperTest {
  private static Event errorEvent(Throwable throwable) {
    return Event.fromThrowable(throwable, true);
  }

  @Test
  void mapsAnExceptionToTheOtelConventions() {
    ErrorLogRecord record = RecordMapper.toLogRecord(errorEvent(new IllegalStateException("card declined")));
    assertEquals("java.lang.IllegalStateException: card declined", record.body);
    assertEquals(Level.ERROR, record.level);
    assertEquals(17, record.level.getSeverityNumber());
    assertEquals("java.lang.IllegalStateException", record.attributes.get("exception.type"));
    assertEquals("card declined", record.attributes.get("exception.message"));
    assertEquals(true, record.attributes.get("exception.handled"));
    String stack = (String) record.attributes.get("exception.stacktrace");
    assertTrue(stack.startsWith("java.lang.IllegalStateException: card declined\n\tat com.instatus.otel."), stack);
    assertEquals("java", StackLanguage.detect(stack));
    assertTrue(((String) record.attributes.get("log.record.uid")).matches("[0-9a-f]{32}"));
  }

  @Test
  void keepsCausesInTheStack() {
    Exception error = new RuntimeException("checkout failed", new java.io.IOException("connection reset"));
    String stack = (String) RecordMapper.toLogRecord(errorEvent(error)).attributes.get("exception.stacktrace");
    assertTrue(stack.contains("Caused by: java.io.IOException: connection reset"), stack);
  }

  @Test
  void usesTheTypeAloneWithoutAMessage() {
    ErrorLogRecord record = RecordMapper.toLogRecord(errorEvent(new NullPointerException()));
    assertEquals("java.lang.NullPointerException", record.body);
    assertEquals("", record.attributes.get("exception.message"));
  }

  @Test
  void mapsLevelsToSeverities() {
    assertEquals(21, Level.FATAL.getSeverityNumber());
    assertEquals("FATAL", Level.FATAL.getSeverityText());
    assertEquals(13, Level.WARNING.getSeverityNumber());
    assertEquals("WARN", Level.WARNING.getSeverityText());
    assertEquals(9, Level.INFO.getSeverityNumber());
    assertEquals(5, Level.DEBUG.getSeverityNumber());
  }

  @Test
  void sendsLowMessagesAsPlainLogs() {
    ErrorLogRecord record = RecordMapper.toLogRecord(Event.fromMessage("cache warmed", Level.INFO));
    assertEquals("cache warmed", record.body);
    assertNull(record.attributes.get("exception.type"));
  }

  @Test
  void sendsErrorMessagesAsIssues() {
    ErrorLogRecord record = RecordMapper.toLogRecord(Event.fromMessage("webhook signature mismatch", Level.ERROR));
    assertEquals("Error", record.attributes.get("exception.type"));
    assertEquals("webhook signature mismatch", record.attributes.get("exception.message"));
    assertFalse(record.attributes.containsKey("exception.handled"));
  }

  @Test
  void flattensScopeMetadata() {
    Event event = errorEvent(new IllegalStateException("boom"));
    new Scope()
        .setTag("plan", "pro")
        .setTag("instatus.internal", "x")
        .setTag("exception.type", "spoofed")
        .setContext("cart", Map.of("items", 3, "currency", "EUR"))
        .setExtra("retry", 2)
        .setExtra("api_key", "sk_live")
        .setExtra("order", Map.of("id", 7, "card", "4111111111111111"))
        .setUser(new User().setEmail("ada@example.com").setUsername("ada").setIpAddress("10.0.0.1").set("tier", "gold"))
        .applyTo(event);
    Map<String, Object> attributes = RecordMapper.toLogRecord(event).attributes;
    assertEquals("pro", attributes.get("plan"));
    assertFalse(attributes.containsKey("instatus.internal"));
    assertEquals("java.lang.IllegalStateException", attributes.get("exception.type"));
    assertEquals(3L, attributes.get("cart.items"));
    assertEquals("EUR", attributes.get("cart.currency"));
    assertEquals(2L, attributes.get("extra.retry"));
    assertEquals("[Filtered]", attributes.get("extra.api_key"));
    String order = (String) attributes.get("extra.order");
    assertTrue(order.contains("\"card\":\"[Filtered]\""), order);
    assertTrue(order.contains("\"id\":7"), order);
    assertEquals("ada@example.com", attributes.get("enduser.id"));
    assertEquals("ada@example.com", attributes.get("user.email"));
    assertEquals("ada", attributes.get("user.name"));
    assertEquals("10.0.0.1", attributes.get("user.ip"));
    assertEquals("gold", attributes.get("user.tier"));
  }

  @Test
  void prefersTheUserIdForEndUser() {
    Event event = errorEvent(new IllegalStateException("boom"));
    event.setUser(new User().setId("42").setEmail("ada@example.com"));
    assertEquals("42", RecordMapper.toLogRecord(event).attributes.get("enduser.id"));
  }

  @Test
  void cutsLongValuesAndStacks() {
    Event event = errorEvent(new IllegalStateException("x".repeat(10_000)));
    event.setStacktrace("s".repeat(40_000));
    event.getTags().put("long", "t".repeat(9000));
    Map<String, Object> attributes = RecordMapper.toLogRecord(event).attributes;
    assertEquals(8192, ((String) attributes.get("exception.message")).length());
    assertEquals(32_000, ((String) attributes.get("exception.stacktrace")).length());
    assertEquals(8192, ((String) attributes.get("long")).length());
  }

  @Test
  void scrubsMessagesAndStacks() {
    ErrorLogRecord record =
        RecordMapper.toLogRecord(errorEvent(new IllegalArgumentException("bad card 4111 1111 1111 1111")));
    assertEquals("java.lang.IllegalArgumentException: bad card [Filtered]", record.body);
    assertEquals("bad card [Filtered]", record.attributes.get("exception.message"));
    assertFalse(((String) record.attributes.get("exception.stacktrace")).contains("4111"));
  }

  @Test
  void addsTheRequestUrlWithoutSecrets() {
    Event event = errorEvent(new IllegalStateException("boom"));
    event.setRequestUrl("https://ada:pw@shop.test/checkout?session=abc&step=2");
    Map<String, Object> attributes = RecordMapper.toLogRecord(event).attributes;
    assertEquals("https://shop.test/checkout?session=[Filtered]&step=2", attributes.get("url.full"));
    assertEquals("/checkout", attributes.get("url.path"));
  }

  @Test
  void filtersUrlsInTagsContextsAndExtras() {
    String url = "https://user:pw@example.com/?token=abc&page=2";
    String filtered = "https://example.com/?token=[Filtered]&page=2";
    Event event = errorEvent(new IllegalStateException("boom"));
    new Scope()
        .setTag("callback", url)
        .setContext("request", Map.of("url", url, "redirects", List.of(url)))
        .setExtra("url", url)
        .setExtra("webhook", Map.of("targets", List.of(Map.of("url", url))))
        .applyTo(event);
    Map<String, Object> attributes = RecordMapper.toLogRecord(event).attributes;
    assertEquals(filtered, attributes.get("callback"));
    assertEquals(filtered, attributes.get("request.url"));
    assertEquals("[\"" + filtered + "\"]", attributes.get("request.redirects"));
    assertEquals(filtered, attributes.get("extra.url"));
    assertEquals("{\"targets\":[{\"url\":\"" + filtered + "\"}]}", attributes.get("extra.webhook"));
  }

  @Test
  void keepsTheErrorFieldsWhenMetadataOverflows() {
    Event event = errorEvent(new IllegalStateException("boom"));
    for (int index = 0; index < 300; index++) event.getTags().put("tag" + index, "v");
    Map<String, Object> attributes = RecordMapper.toLogRecord(event).attributes;
    assertEquals(RecordMapper.MAX_ATTRIBUTES, attributes.size());
    assertTrue(attributes.keySet().containsAll(List.of("exception.type", "exception.stacktrace", "log.record.uid")));
  }

  @Test
  void convertsValuesToAttributeTypes() {
    assertEquals(5L, RecordMapper.toAttributeValue(5));
    assertEquals(1.5, RecordMapper.toAttributeValue(1.5f));
    assertEquals(true, RecordMapper.toAttributeValue(true));
    assertEquals("12345678901234567890", RecordMapper.toAttributeValue(new java.math.BigInteger("12345678901234567890")));
    assertEquals("[1,\"a\",null]", RecordMapper.toAttributeValue(java.util.Arrays.asList(1, "a", null)));
    assertNull(RecordMapper.toAttributeValue(null));
  }
}
