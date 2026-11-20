package com.instatus.otel;

import java.util.function.LongSupplier;

final class RateCap {
  private final int limit;
  private final long windowMillis;
  private final LongSupplier clock;
  private long windowStart;
  private int count;

  RateCap(int limit, long windowMillis, LongSupplier clock) {
    this.limit = limit;
    this.windowMillis = windowMillis;
    this.clock = clock;
    this.windowStart = clock.getAsLong();
  }

  synchronized boolean take() {
    long now = clock.getAsLong();
    if (now - windowStart >= windowMillis) {
      windowStart = now;
      count = 0;
    }
    if (count >= limit) return false;
    count++;
    return true;
  }
}
