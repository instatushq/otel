package com.instatus.otel;

import java.util.Map;

final class Json {
  private Json() {}

  static String write(Object value) {
    StringBuilder out = new StringBuilder();
    append(out, value);
    return out.toString();
  }

  private static void append(StringBuilder out, Object value) {
    if (value == null) {
      out.append("null");
    } else if (value instanceof Boolean) {
      out.append(value);
    } else if (value instanceof Number) {
      appendNumber(out, (Number) value);
    } else if (value instanceof Map) {
      appendMap(out, (Map<?, ?>) value);
    } else if (value instanceof Iterable) {
      appendList(out, (Iterable<?>) value);
    } else {
      appendString(out, readable(value));
    }
  }

  private static String readable(Object value) {
    try {
      return String.valueOf(value);
    } catch (RuntimeException unreadable) {
      return Scrubber.UNREADABLE;
    }
  }

  private static void appendNumber(StringBuilder out, Number number) {
    boolean notFinite =
        (number instanceof Double && !Double.isFinite(number.doubleValue()))
            || (number instanceof Float && !Float.isFinite(number.floatValue()));
    out.append(notFinite ? "null" : number.toString());
  }

  private static void appendMap(StringBuilder out, Map<?, ?> map) {
    out.append('{');
    boolean first = true;
    for (Map.Entry<?, ?> entry : map.entrySet()) {
      if (!first) out.append(',');
      first = false;
      appendString(out, String.valueOf(entry.getKey()));
      out.append(':');
      append(out, entry.getValue());
    }
    out.append('}');
  }

  private static void appendList(StringBuilder out, Iterable<?> list) {
    out.append('[');
    boolean first = true;
    for (Object element : list) {
      if (!first) out.append(',');
      first = false;
      append(out, element);
    }
    out.append(']');
  }

  private static void appendString(StringBuilder out, String text) {
    out.append('"');
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      switch (character) {
        case '"':
          out.append("\\\"");
          break;
        case '\\':
          out.append("\\\\");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        default:
          if (character < 0x20) out.append(String.format("\\u%04x", (int) character));
          else out.append(character);
      }
    }
    out.append('"');
  }
}
