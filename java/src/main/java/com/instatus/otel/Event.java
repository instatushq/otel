package com.instatus.otel;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Sentry's event shape, handed to {@code beforeSend}. The one difference: {@link #getStacktrace()}
 * is the JVM's own stack text, which OpenTelemetry sends as {@code exception.stacktrace}.
 */
public final class Event {
  private final String eventId;
  private final Instant timestamp;
  private final Throwable throwable;
  private Level level;
  private String message;
  private String exceptionType;
  private String exceptionMessage;
  private String stacktrace;
  private Boolean handled;
  private User user;
  private String release;
  private String environment;
  private String requestUrl;
  private final Map<String, String> tags = new LinkedHashMap<>();
  private final Map<String, Object> extra = new LinkedHashMap<>();
  private final Map<String, Map<String, Object>> contexts = new LinkedHashMap<>();

  private Event(Throwable throwable, Level level) {
    this.eventId = UUID.randomUUID().toString().replace("-", "");
    this.timestamp = Instant.now();
    this.throwable = throwable;
    this.level = level;
  }

  static Event fromThrowable(Throwable throwable, boolean handled) {
    Event event = new Event(throwable, Level.ERROR);
    event.exceptionType = throwable.getClass().getName();
    String message = throwable.getLocalizedMessage();
    event.exceptionMessage = message == null ? "" : message;
    event.stacktrace = stackTraceOf(throwable);
    event.handled = handled;
    return event;
  }

  static Event fromMessage(String message, Level level) {
    Event event = new Event(null, level);
    event.message = message == null ? "" : message;
    return event;
  }

  static String stackTraceOf(Throwable throwable) {
    StringWriter text = new StringWriter();
    try (PrintWriter writer = new PrintWriter(text)) {
      throwable.printStackTrace(writer);
    } catch (RuntimeException unprintable) {
      return null;
    }
    return text.toString();
  }

  /** 32 hex characters, sent as {@code log.record.uid}. */
  public String getEventId() {
    return eventId;
  }

  public Instant getTimestamp() {
    return timestamp;
  }

  /** The captured exception, or null for a message. */
  public Throwable getThrowable() {
    return throwable;
  }

  public Level getLevel() {
    return level;
  }

  public void setLevel(Level level) {
    if (level != null) this.level = level;
  }

  public String getMessage() {
    return message;
  }

  public void setMessage(String message) {
    this.message = message;
  }

  public String getExceptionType() {
    return exceptionType;
  }

  public void setExceptionType(String exceptionType) {
    this.exceptionType = exceptionType;
  }

  public String getExceptionMessage() {
    return exceptionMessage;
  }

  public void setExceptionMessage(String exceptionMessage) {
    this.exceptionMessage = exceptionMessage;
  }

  public String getStacktrace() {
    return stacktrace;
  }

  public void setStacktrace(String stacktrace) {
    this.stacktrace = stacktrace;
  }

  /** False for an uncaught exception, true for one passed to captureException, null for a message. */
  public Boolean getHandled() {
    return handled;
  }

  public User getUser() {
    return user;
  }

  public void setUser(User user) {
    this.user = user;
  }

  public String getRelease() {
    return release;
  }

  public void setRelease(String release) {
    this.release = release;
  }

  public String getEnvironment() {
    return environment;
  }

  public void setEnvironment(String environment) {
    this.environment = environment;
  }

  public String getRequestUrl() {
    return requestUrl;
  }

  public void setRequestUrl(String requestUrl) {
    this.requestUrl = requestUrl;
  }

  /** The event's tags; change the map to change what is sent. */
  public Map<String, String> getTags() {
    return tags;
  }

  public Map<String, Object> getExtra() {
    return extra;
  }

  public Map<String, Map<String, Object>> getContexts() {
    return contexts;
  }

  boolean hasException() {
    return exceptionType != null;
  }
}
