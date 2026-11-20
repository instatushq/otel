package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ScrubberTest {
  @Test
  void matchesSensitiveKeys() {
    for (String key :
        List.of(
            "password", "passwd", "PASS", "client_secret", "X-Api-Key", "apikey", "api.key", "Authorization",
            "sessionId", "csrf_token", "xsrf", "private_key", "signature", "refresh-token", "credentials", "Cookie")) {
      assertTrue(Scrubber.isSensitiveKey(key), key);
    }
    for (String key : List.of("username", "email", "path", "plan", "id")) {
      assertFalse(Scrubber.isSensitiveKey(key), key);
    }
  }

  @Test
  void filtersCardNumbersThatPassLuhn() {
    assertEquals("paid with [Filtered] today", Scrubber.scrubText("paid with 4111 1111 1111 1111 today"));
    assertEquals("[Filtered]", Scrubber.scrubText("4111-1111-1111-1111"));
    assertEquals("card=[Filtered]", Scrubber.scrubText("card=5500005555555559"));
    assertEquals("[Filtered]", Scrubber.scrubText("378282246310005"));
  }

  @Test
  void keepsNumbersThatAreNotCards() {
    assertEquals("order 4111111111111112", Scrubber.scrubText("order 4111111111111112"));
    assertEquals("id 123456789012", Scrubber.scrubText("id 123456789012"));
    assertEquals("at 1700000000001", Scrubber.scrubText("at 1700000000001"));
    assertFalse(Scrubber.passesLuhn("1700000000001"));
  }

  @Test
  void removesUrlCredentialsAndSecretParameters() {
    assertEquals(
        "https://example.com/a?token=[Filtered]&page=2#access_token=[Filtered]",
        Scrubber.scrubUrl("https://user:hunter2@example.com/a?token=abc&page=2#access_token=xyz"));
    assertEquals("https://example.com/?api%5Fkey=[Filtered]", Scrubber.scrubUrl("https://example.com/?api%5Fkey=1"));
    assertEquals(
        "https://shop.test/pay?number=[Filtered]&step=2",
        Scrubber.scrubUrl("https://shop.test/pay?number=4111111111111111&step=2"));
    assertEquals("/checkout?plan=pro", Scrubber.scrubUrl("/checkout?plan=pro"));
  }

  @Test
  void filtersUrlsInValues() {
    assertEquals(
        "https://example.com/?token=[Filtered]",
        Scrubber.scrubValue("url", "https://user:pw@example.com/?token=abc"));
    assertEquals(
        "HTTPS://example.com/pay?number=[Filtered]",
        Scrubber.scrubValue("url", "HTTPS://ada@example.com/pay?number=4111111111111111"));
    Map<String, Object> nested = Map.of("next", List.of("postgres://admin:pw@db.test/app?sslmode=require&password=x"));
    assertEquals(
        Map.of("next", List.of("postgres://db.test/app?sslmode=require&password=[Filtered]")),
        Scrubber.scrubValue("redirect", nested));
  }

  @Test
  void keepsTextThatIsNotAUrl() {
    assertEquals("retry with ?token=abc", Scrubber.scrubValue("hint", "retry with ?token=abc"));
    assertEquals("see https://ada:pw@example.com", Scrubber.scrubValue("hint", "see https://ada:pw@example.com"));
    assertEquals("card [Filtered]", Scrubber.scrubValue("hint", "card 4111 1111 1111 1111"));
  }

  @Test
  void filtersNestedMapsAndLists() {
    Map<String, Object> request = new LinkedHashMap<>();
    request.put("password", "hunter2");
    request.put("name", "Ada");
    request.put("cards", List.of(Map.of("token", "tok_1", "last4", "4242"), "4111 1111 1111 1111"));
    @SuppressWarnings("unchecked")
    Map<String, Object> scrubbed = (Map<String, Object>) Scrubber.scrubValue("request", request);
    assertEquals("[Filtered]", scrubbed.get("password"));
    assertEquals("Ada", scrubbed.get("name"));
    assertEquals(List.of(Map.of("token", "[Filtered]", "last4", "4242"), "[Filtered]"), scrubbed.get("cards"));
  }

  @Test
  void filtersEverythingUnderASensitiveKey() {
    assertEquals("[Filtered]", Scrubber.scrubValue("auth", Map.of("user", "ada")));
    assertEquals("[Filtered]", Scrubber.scrubValue("session", null));
  }

  @Test
  void cutsCyclesButKeepsSharedValues() {
    Map<String, Object> address = Map.of("city", "Paris");
    Map<String, Object> order = new LinkedHashMap<>();
    order.put("billing", address);
    order.put("shipping", address);
    order.put("self", order);
    List<Object> list = new ArrayList<>();
    list.add(list);
    order.put("list", list);
    @SuppressWarnings("unchecked")
    Map<String, Object> scrubbed = (Map<String, Object>) Scrubber.scrubValue("order", order);
    assertEquals(address, scrubbed.get("billing"));
    assertEquals(address, scrubbed.get("shipping"));
    assertEquals("[Circular]", scrubbed.get("self"));
    assertEquals(List.of("[Circular]"), scrubbed.get("list"));
  }

  @Test
  void truncatesDeepValues() {
    Object value = "deep";
    for (int depth = 0; depth < 8; depth++) value = Map.of("next", value);
    Object scrubbed = Scrubber.scrubValue("root", value);
    for (int depth = 0; depth < Scrubber.MAX_DEPTH; depth++) scrubbed = ((Map<?, ?>) scrubbed).get("next");
    assertEquals("[Truncated]", scrubbed);
  }

  @Test
  void readsArrays() {
    assertEquals(List.of(1, 2), Scrubber.scrubValue("ids", new int[] {1, 2}));
    assertEquals(List.of("[Filtered]", "ok"), Scrubber.scrubValue("values", new String[] {"4111111111111111", "ok"}));
  }
}
