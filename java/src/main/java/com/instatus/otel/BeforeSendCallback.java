package com.instatus.otel;

/** Changes an event before it is sent, or returns null to drop it. */
@FunctionalInterface
public interface BeforeSendCallback {
  Event execute(Event event);
}
