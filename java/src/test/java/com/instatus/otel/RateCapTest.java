package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class RateCapTest {
  @Test
  void capsEachWindow() {
    AtomicLong now = new AtomicLong();
    RateCap cap = new RateCap(2, 60_000, now::get);
    assertTrue(cap.take());
    assertTrue(cap.take());
    assertFalse(cap.take());
    now.set(59_999);
    assertFalse(cap.take());
    now.set(60_000);
    assertTrue(cap.take());
  }
}
