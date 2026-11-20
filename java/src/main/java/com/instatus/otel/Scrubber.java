package com.instatus.otel;

import java.lang.reflect.Array;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.MatchResult;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class Scrubber {
  static final String FILTERED = "[Filtered]";
  static final String CIRCULAR = "[Circular]";
  static final String TRUNCATED = "[Truncated]";
  static final String UNREADABLE = "[Unreadable]";
  static final int MAX_DEPTH = 6;

  private static final Pattern SENSITIVE_KEY =
      Pattern.compile(
          "pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature",
          Pattern.CASE_INSENSITIVE);
  private static final Pattern CARD_NUMBER = Pattern.compile("\\b\\d(?:[ -]?\\d){12,18}\\b");
  private static final Pattern URL_SCHEME = Pattern.compile("^[a-z][a-z0-9+.-]*://", Pattern.CASE_INSENSITIVE);
  private static final Pattern URL_CREDENTIALS =
      Pattern.compile("^([a-z][a-z0-9+.-]*://)[^/@?#]*@", Pattern.CASE_INSENSITIVE);
  private static final Pattern URL_PARAM = Pattern.compile("([?&#])([^=&#]+)=([^&#]*)");

  private Scrubber() {}

  static boolean isSensitiveKey(String key) {
    return key != null && SENSITIVE_KEY.matcher(key).find();
  }

  static String scrubText(String text) {
    if (text == null || text.isEmpty()) return text;
    return CARD_NUMBER.matcher(text).replaceAll(match -> Matcher.quoteReplacement(cardOrText(match.group())));
  }

  // A card number can sit in any parameter (?number=4111…), so URLs get the text filter too.
  static String scrubUrl(String url) {
    if (url == null) return null;
    String withoutCredentials = URL_CREDENTIALS.matcher(url).replaceFirst("$1");
    String withoutSecrets =
        URL_PARAM.matcher(withoutCredentials).replaceAll(match -> Matcher.quoteReplacement(filterParam(match)));
    return scrubText(withoutSecrets);
  }

  private static String scrubString(String text) {
    if (URL_SCHEME.matcher(text).find()) return scrubUrl(text);
    return scrubText(text);
  }

  static Object scrubValue(String key, Object value) {
    return scrubNested(key, value, 0, Collections.newSetFromMap(new IdentityHashMap<>()));
  }

  private static String cardOrText(String match) {
    return passesLuhn(match.replaceAll("\\D", "")) ? FILTERED : match;
  }

  private static String filterParam(MatchResult match) {
    if (!isSensitiveKey(decode(match.group(2)))) return match.group();
    return match.group(1) + match.group(2) + "=" + FILTERED;
  }

  private static String decode(String value) {
    try {
      return URLDecoder.decode(value, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException malformed) {
      return value;
    }
  }

  // The Luhn check keeps timestamps and order numbers of card length.
  static boolean passesLuhn(String digits) {
    int sum = 0;
    for (int index = 0; index < digits.length(); index++) {
      int digit = digits.charAt(digits.length() - 1 - index) - '0';
      if (index % 2 == 1) digit *= 2;
      if (digit > 9) digit -= 9;
      sum += digit;
    }
    return sum % 10 == 0;
  }

  private static boolean isContainer(Object value) {
    return value instanceof Map || value instanceof Iterable || (value != null && value.getClass().isArray());
  }

  // ancestors holds the containers on the current path only, so a value used twice (billing and
  // shipping address) is kept and only a real cycle is cut.
  private static Object scrubNested(String key, Object value, int depth, Set<Object> ancestors) {
    if (isSensitiveKey(key)) return FILTERED;
    if (value instanceof CharSequence) return scrubString(value.toString());
    if (!isContainer(value)) return value;
    if (ancestors.contains(value)) return CIRCULAR;
    if (depth >= MAX_DEPTH) return TRUNCATED;
    ancestors.add(value);
    try {
      return scrubChildren(value, depth, ancestors);
    } catch (RuntimeException unreadable) {
      return UNREADABLE;
    } finally {
      ancestors.remove(value);
    }
  }

  private static Object scrubChildren(Object value, int depth, Set<Object> ancestors) {
    if (value instanceof Map) {
      Map<String, Object> scrubbed = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        String childKey = String.valueOf(entry.getKey());
        scrubbed.put(childKey, scrubNested(childKey, entry.getValue(), depth + 1, ancestors));
      }
      return scrubbed;
    }
    List<Object> scrubbed = new ArrayList<>();
    int index = 0;
    for (Object child : elementsOf(value)) {
      scrubbed.add(scrubNested(String.valueOf(index), child, depth + 1, ancestors));
      index++;
    }
    return scrubbed;
  }

  private static Iterable<?> elementsOf(Object value) {
    if (value instanceof Iterable) return (Iterable<?>) value;
    int length = Array.getLength(value);
    List<Object> elements = new ArrayList<>(length);
    for (int index = 0; index < length; index++) elements.add(Array.get(value, index));
    return elements;
  }
}
