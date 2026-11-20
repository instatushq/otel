# com.instatus:instatus-otel

Error tracking, logs, traces and metrics for Java servers, built on
OpenTelemetry, with the Sentry SDK's API. Errors show up in Instatus Errors
with their stack, user and release; logs and traces land in Logs and Traces.

- **OpenTelemetry underneath.** Errors are OTel log records in the semantic
  conventions (`exception.type`, `exception.message`, `exception.stacktrace`),
  emitted on the official OpenTelemetry Java SDK. Library instrumentations you
  add flow through it, and the `OTEL_*` environment variables work as usual.
- **Sentry on top.** `init`, `captureException`, `setUser`, `withScope` and the
  rest read like Sentry's Java SDK, so moving over is mostly an import swap.
- **`java.util.logging` included.** Records from the standard logger reach
  Logs with no extra code, and uncaught exceptions are reported before the
  thread dies.

Java 11 or newer.

## Install

Maven:

```xml
<dependency>
  <groupId>com.instatus</groupId>
  <artifactId>instatus-otel</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle:

```kotlin
implementation("com.instatus:instatus-otel:0.1.0")
```

## Start

```java
import com.instatus.otel.Instatus;

public final class Main {
  public static void main(String[] args) {
    Instatus.init(options -> options
        .apiKey(System.getenv("INSTATUS_API_KEY"))
        .siteId(System.getenv("INSTATUS_SITE_ID"))
        .release(System.getenv("GIT_SHA")));

    startServer();
  }
}
```

With an API key, errors, traces, logs and metrics go to
`https://otel.instatus.com` over OTLP/HTTP protobuf, with
`Authorization: Bearer <key>` and `X-Instatus-Site-Id: <site id>`. Leave
`apiKey` and `siteId` out to read `INSTATUS_API_KEY` and `INSTATUS_SITE_ID`.

Point it anywhere else with `endpoint` (the SDK adds `/v1/logs`,
`/v1/traces` and `/v1/metrics`), or, without a key, with the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` and
`OTEL_EXPORTER_OTLP_HEADERS` variables. `OTEL_SERVICE_NAME` and
`OTEL_RESOURCE_ATTRIBUTES` are read too.

`init` registers the SDK as `GlobalOpenTelemetry`, with W3C trace context
propagation and a parent-based sampler. Hand `Instatus.getOpenTelemetry()` to
the OpenTelemetry library instrumentations you use:

```java
OkHttpClient client = OkHttpTelemetry.builder(Instatus.getOpenTelemetry())
    .build()
    .newCallFactory(new OkHttpClient());
```

If the OpenTelemetry Java agent already owns `GlobalOpenTelemetry`, Instatus
keeps its own SDK and says so in a warning.

### Uncaught exceptions

`init` installs a default uncaught exception handler. An exception that ends
a thread is reported at level `fatal` with `exception.handled = false`, and
the SDK waits for it to be sent. Then the handler that was there before runs,
or, when there was none, the stack is printed the way the JVM prints it. A
shutdown hook sends whatever is still queued when the JVM exits.

### Logging

`java.util.logging` records at `INFO` and above go to Logs through a handler
on the root logger, with the formatted message as the body and the thrown
exception as `exception.*` attributes. Change the level with `loggingLevel`,
or turn it off with `Level.OFF`:

```java
Instatus.init(options -> options.loggingLevel(java.util.logging.Level.WARNING));
```

If you configure logging with `logging.properties`, list
`com.instatus.otel.InstatusLogHandler` among the root handlers. SLF4J and
Log4j apps can route to `java.util.logging` with their JUL bridges, or add
the OpenTelemetry appender for their logger.

## Moving from Sentry

```diff
- import io.sentry.Sentry;
+ import com.instatus.otel.Instatus;

- Sentry.init(options -> options.setDsn(dsn));
+ Instatus.init(options -> options.apiKey(apiKey).siteId(siteId));

- Sentry.captureException(error);
+ Instatus.captureException(error);
```

The functions keep Sentry's shape. The differences:

- Servers authenticate with an API key, not a DSN.
- `Event.getStacktrace()` in `beforeSend` is the JVM's own stack text
  (`Throwable.printStackTrace`), which is what OpenTelemetry sends, not
  Sentry's parsed frames.
- Breadcrumbs, profiling and session tracking aren't included.
- Tags, contexts and extras become attributes: `setTag("plan", "pro")` is
  `plan`, `setContext("cart", Map.of("items", 3))` is `cart.items`, and
  `setExtra("retry", 2)` is `extra.retry`.
- `release` is `service.version`, `environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.

## Options

| Option                  | What it does                                               | Default              |
| ----------------------- | ---------------------------------------------------------- | -------------------- |
| `apiKey`, `siteId`      | Send every signal to the Instatus collector                | `INSTATUS_*` env     |
| `endpoint`              | Another OTLP/HTTP endpoint                                 | `otel.instatus.com`  |
| `serviceName`           | `service.name`                                             | `OTEL_SERVICE_NAME`, then `java` |
| `release`               | `service.version`                                          |                      |
| `environment`           | `deployment.environment.name`                              |                      |
| `tracesSampleRate`      | Share of traces to keep, 0 to 1                            | `1`                  |
| `beforeSend`            | Change an event or return `null` to drop it                |                      |
| `maxEventsPerMinute`    | Errors sent per minute                                     | `300`                |
| `loggingLevel`          | Lowest `java.util.logging` level sent to Logs              | `INFO`               |
| `addSpanProcessor`      | Another span processor, such as a logging exporter         |                      |
| `addLogRecordProcessor` | Another log record processor                               |                      |
| `metricsExportInterval` | How often metrics are exported                             | 60 seconds           |
| `shutdownTimeout`       | How long exit and uncaught handlers wait for sends         | 2 seconds            |
| `debug`                 | Log why events are dropped                                 | `false`              |
| `enabled`               | `false` keeps the SDK quiet, for tests and local dev       | `true`               |

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization` are
replaced with `[Filtered]` (inside maps and lists too), card numbers are
filtered out of messages, stacks and values, and URLs lose their credentials
and secret query parameters. The process's command line stays out of the
resource, since JVM flags often hold secrets.

## Functions

### `Instatus.init(options)`

Starts the SDK. Call it once, as early as you can. Takes an
`InstatusOptions` or a function that sets options on its builder.

```java
Instatus.init(InstatusOptions.builder().apiKey(apiKey).release("api@1.4.0").build());
```

### `captureException(error)` / `captureException(error, scope -> ...)`

Reports an error you caught. Returns the event id. Changes made to the scope
in the second form apply to this event only.

```java
try {
  chargeCard(order);
} catch (PaymentException error) {
  Instatus.captureException(error, scope -> scope.setTag("step", "charge"));
}
```

### `captureMessage(message, level)`

Reports a message. `Level.ERROR` and `Level.FATAL` messages are issues in
Errors; lower levels are plain logs. The level defaults to `INFO`.

```java
Instatus.captureMessage("Stripe webhook signature mismatch", Level.ERROR);
```

### `setUser(user)`

Sets who is affected. Pass `null` on sign-out.

```java
Instatus.setUser(new User().setId(account.getId()).setEmail(account.getEmail()));
```

### `setTag(key, value)` / `setTags(tags)`

Adds attributes you can filter by.

```java
Instatus.setTags(Map.of("plan", "pro", "region", "eu"));
```

### `setContext(name, context)`

Adds a group of details, flattened into `name.key` attributes.

```java
Instatus.setContext("cart", Map.of("items", 3, "currency", "EUR"));
```

### `setExtra(key, value)`

Adds a detail as `extra.key`.

```java
Instatus.setExtra("retry", 2);
```

### `withScope(scope -> ...)`

Runs the callback with a copy of the scope, so changes stay inside it. Wrap
each request or job in one, so one request's user never reaches another's
errors:

```java
Instatus.withScope(scope -> {
  scope.setUser(new User().setId(userId));
  scope.setRequestUrl(request.getRequestURL().toString());
  chain.doFilter(request, response);
});
```

The copy lives in the OpenTelemetry `Context`, so `Context.current().wrap(...)`
carries it to executor threads. Outside `withScope`, the `set*` functions
change the current thread's scope; use `Instatus.getGlobalScope()` for values
every thread should send.

### `startSpan(name, callback)`

Runs the callback inside an OpenTelemetry span and ends it when the callback
returns. A thrown exception marks the span as failed and is rethrown.
`Span.current()` is the span inside.

```java
Invoice invoice = Instatus.startSpan("build-invoice", () -> buildInvoice(order));
```

Errors captured inside a span carry its trace id, and the span gets an
`exception` event and an error status.

### `flush(timeout)` / `close(timeout)`

Sends what is queued. `close` also shuts the SDK down. Both return `false`
if the timeout passes first.

```java
Instatus.flush(Duration.ofSeconds(2));
```

## How errors reach Instatus

| From          | Sent to                                      | Authenticated by                        |
| ------------- | -------------------------------------------- | --------------------------------------- |
| Java, API key | `otel.instatus.com/v1/{logs,traces,metrics}` | `Authorization: Bearer`, site id header |

Errors parses the JVM's stack text into frames, marking JDK, Spring, Apache,
Netty and other library packages as not your code.

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.
