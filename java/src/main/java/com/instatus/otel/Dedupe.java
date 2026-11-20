package com.instatus.otel;

import java.util.Objects;

// Same as Sentry's Dedupe integration: an event identical to the one just sent is a re-throw, or
// a handler and a filter both reporting one error.
final class Dedupe {
  private String previous;

  synchronized boolean isDuplicate(Event event) {
    String signature = signatureOf(event);
    boolean duplicate = Objects.equals(signature, previous);
    previous = signature;
    return duplicate;
  }

  private static String signatureOf(Event event) {
    if (!event.hasException()) return "message|" + Objects.toString(event.getMessage(), "");
    return event.getExceptionType()
        + "|"
        + Objects.toString(event.getExceptionMessage(), "")
        + "|"
        + Objects.toString(event.getStacktrace(), "");
  }
}
