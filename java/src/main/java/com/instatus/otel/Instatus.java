package com.instatus.otel;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.ContextKey;
import java.time.Duration;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Errors, logs, traces and metrics for Java servers on OpenTelemetry, with the Sentry SDK's API.
 *
 * <pre>{@code
 * Instatus.init(options -> options.apiKey(System.getenv("INSTATUS_API_KEY")).release("api@1.4.0"));
 * }</pre>
 */
public final class Instatus {
  private static final ContextKey<Scope> SCOPE_KEY = ContextKey.named("instatus.scope");
  private static final Scope GLOBAL_SCOPE = new Scope();
  private static final ThreadLocal<Scope> THREAD_SCOPE = ThreadLocal.withInitial(Scope::new);
  private static final String EMPTY_EVENT_ID = "00000000000000000000000000000000";
  private static final Object LOCK = new Object();
  private static volatile Client client;

  private Instatus() {}

  /** Starts the SDK. Call it once, as early as you can; later calls are ignored until {@link #close}. */
  public static void init(InstatusOptions options) {
    InstatusOptions resolved = options == null ? InstatusOptions.builder().build() : options;
    synchronized (LOCK) {
      if (client != null) {
        Client.LOG.warning("[instatus] init was already called; call close first to start again");
        return;
      }
      Client started = Client.start(resolved);
      setGlobal(started.sdk);
      client = started;
      started.install();
    }
  }

  /** Starts the SDK with options set on a builder. */
  public static void init(Consumer<InstatusOptions.Builder> configure) {
    InstatusOptions.Builder builder = InstatusOptions.builder();
    if (configure != null) configure.accept(builder);
    init(builder.build());
  }

  private static void setGlobal(OpenTelemetry sdk) {
    try {
      GlobalOpenTelemetry.set(sdk);
    } catch (IllegalStateException alreadySet) {
      Client.LOG.warning(
          "[instatus] another OpenTelemetry SDK is already global (the Java agent?); Instatus exports through its own");
    }
  }

  public static boolean isInitialized() {
    return client != null;
  }

  /** The SDK's OpenTelemetry, for library instrumentations; a no-op one before {@link #init}. */
  public static OpenTelemetry getOpenTelemetry() {
    Client current = client;
    if (current == null) return OpenTelemetry.noop();
    return current.sdk;
  }

  /** Reports an error you caught. Returns the event id. */
  public static String captureException(Throwable error) {
    return captureException(error, null);
  }

  /** Reports an error with changes to a copy of the scope that apply to this event only. */
  public static String captureException(Throwable error, Consumer<Scope> configure) {
    if (error == null) return EMPTY_EVENT_ID;
    return capture(Event.fromThrowable(error, true), configure);
  }

  /** Reports a message at {@link Level#INFO}. */
  public static String captureMessage(String message) {
    return captureMessage(message, Level.INFO);
  }

  /** Reports a message. Error and fatal messages are issues in Errors; lower levels are plain logs. */
  public static String captureMessage(String message, Level level) {
    return capture(Event.fromMessage(message, level == null ? Level.INFO : level), null);
  }

  static String captureUncaught(Throwable error) {
    return capture(Event.fromThrowable(error, false), scope -> scope.setLevel(Level.FATAL));
  }

  private static String capture(Event event, Consumer<Scope> configure) {
    Client current = client;
    if (current == null) return event.getEventId();
    try {
      GLOBAL_SCOPE.applyTo(event);
      scopeFor(configure).applyTo(event);
    } catch (RuntimeException failure) {
      Client.LOG.fine("[instatus] could not apply the scope: " + failure);
    }
    return current.capture(event);
  }

  private static Scope scopeFor(Consumer<Scope> configure) {
    Scope scope = getCurrentScope();
    if (configure == null) return scope;
    Scope copy = scope.copy();
    configure.accept(copy);
    return copy;
  }

  /** Sets who is affected on the current scope; null clears it. */
  public static void setUser(User user) {
    getCurrentScope().setUser(user);
    Span span = Span.current();
    String endUserId = user == null ? null : user.endUserId();
    if (span.isRecording() && endUserId != null) span.setAttribute("enduser.id", endUserId);
  }

  public static void setTag(String key, String value) {
    getCurrentScope().setTag(key, value);
  }

  public static void setTags(Map<String, String> tags) {
    getCurrentScope().setTags(tags);
  }

  public static void setContext(String name, Map<String, ?> context) {
    getCurrentScope().setContext(name, context);
  }

  public static void setExtra(String key, Object value) {
    getCurrentScope().setExtra(key, value);
  }

  /**
   * Runs {@code callback} with a copy of the current scope, so its changes stay inside. The copy
   * lives in the OpenTelemetry context, so {@code Context.current().wrap(...)} carries it to other
   * threads.
   */
  public static void withScope(Consumer<Scope> callback) {
    if (callback == null) return;
    Scope copy = getCurrentScope().copy();
    try (io.opentelemetry.context.Scope ignored = Context.current().with(SCOPE_KEY, copy).makeCurrent()) {
      callback.accept(copy);
    }
  }

  /** The scope of the current {@link #withScope} block, or else of the current thread. */
  public static Scope getCurrentScope() {
    Scope fromContext = Context.current().get(SCOPE_KEY);
    if (fromContext != null) return fromContext;
    return THREAD_SCOPE.get();
  }

  /** The scope applied to every event, on every thread. */
  public static Scope getGlobalScope() {
    return GLOBAL_SCOPE;
  }

  /** Runs {@code callback} inside a span that ends when it returns. A thrown error marks the span failed. */
  public static <T> T startSpan(String name, Supplier<T> callback) {
    Span span = tracer().spanBuilder(name == null ? "span" : name).startSpan();
    try (io.opentelemetry.context.Scope ignored = span.makeCurrent()) {
      return callback.get();
    } catch (RuntimeException | Error failure) {
      span.setStatus(StatusCode.ERROR, describe(failure));
      throw failure;
    } finally {
      span.end();
    }
  }

  public static void startSpan(String name, Runnable callback) {
    startSpan(
        name,
        () -> {
          callback.run();
          return null;
        });
  }

  private static String describe(Throwable failure) {
    String message = failure.getMessage();
    if (message != null) return Scrubber.scrubText(message);
    return failure.getClass().getName();
  }

  private static Tracer tracer() {
    return getOpenTelemetry().getTracer(Version.SDK_NAME, Version.VERSION);
  }

  /** Sends what is queued. Returns false if the timeout passes first. */
  public static boolean flush(Duration timeout) {
    Client current = client;
    if (current == null) return true;
    return current.flush(timeoutOrDefault(timeout));
  }

  /** Sends what is queued and shuts the SDK down. Returns false if the timeout passes first. */
  public static boolean close(Duration timeout) {
    Client current;
    synchronized (LOCK) {
      current = client;
      client = null;
    }
    if (current == null) return true;
    current.uninstall();
    return current.shutdown(timeoutOrDefault(timeout));
  }

  private static Duration timeoutOrDefault(Duration timeout) {
    return timeout == null ? InstatusOptions.DEFAULT_SHUTDOWN_TIMEOUT : timeout;
  }
}
