package com.instatus.otel;

import java.util.regex.Pattern;

// A port of detectStackLanguage in packages/backend/src/modules/issues/helpers/stack-frames.ts.
final class StackLanguage {
  private static final Pattern PYTHON_TRACEBACK = Pattern.compile("Traceback \\(most recent call last\\)");
  private static final Pattern PYTHON_FILE = Pattern.compile("^\\s*File \".*\", line \\d+", Pattern.MULTILINE);
  private static final Pattern GO_ROUTINE = Pattern.compile("^goroutine \\d+ \\[", Pattern.MULTILINE);
  private static final Pattern GO_FILE = Pattern.compile("^\\t.*\\.go:\\d+", Pattern.MULTILINE);
  private static final Pattern NATIVE = Pattern.compile("^\\d+\\t[^\\t]+\\t0x[0-9a-fA-F]+\\t", Pattern.MULTILINE);
  private static final Pattern PHP = Pattern.compile("^#\\d+ ", Pattern.MULTILINE);
  private static final Pattern RUBY = Pattern.compile(":\\d+:in [`']");
  private static final Pattern JAVA =
      Pattern.compile(
          "^\\s*at [\\w$./<>-]+\\((?:[\\w$-]+\\.(?:java|kt|scala|groovy|clj):\\d+|Native Method|Unknown Source)\\)",
          Pattern.MULTILINE);

  private StackLanguage() {}

  static String detect(String stack) {
    if (PYTHON_TRACEBACK.matcher(stack).find() || PYTHON_FILE.matcher(stack).find()) return "python";
    if (GO_ROUTINE.matcher(stack).find() || GO_FILE.matcher(stack).find()) return "go";
    if (NATIVE.matcher(stack).find()) return "native";
    if (PHP.matcher(stack).find()) return "php";
    if (RUBY.matcher(stack).find()) return "ruby";
    if (JAVA.matcher(stack).find()) return "java";
    return "other";
  }
}
