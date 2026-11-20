package com.instatus.otel;

import java.time.Duration;

// Reports and flushes, then hands over to the handler that was there before, or prints the way
// the JVM does when there is none.
final class UncaughtExceptionHandler implements Thread.UncaughtExceptionHandler {
  private final Thread.UncaughtExceptionHandler previous;
  private final Duration flushTimeout;

  UncaughtExceptionHandler(Thread.UncaughtExceptionHandler previous, Duration flushTimeout) {
    this.previous = previous;
    this.flushTimeout = flushTimeout;
  }

  @Override
  public void uncaughtException(Thread thread, Throwable error) {
    try {
      Instatus.captureUncaught(error);
      Instatus.flush(flushTimeout);
    } catch (RuntimeException reportingFailed) {
      Client.LOG.fine("[instatus] could not report an uncaught exception: " + reportingFailed);
    }
    if (previous != null) {
      previous.uncaughtException(thread, error);
      return;
    }
    System.err.print("Exception in thread \"" + thread.getName() + "\" ");
    error.printStackTrace(System.err);
  }
}
