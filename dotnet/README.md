# Instatus.Otel

Error tracking, logs, traces and metrics for .NET apps, built on
OpenTelemetry, with the Sentry SDK's API. Errors show up in Instatus Errors
with their .NET stack, user, tags and release.

- **OpenTelemetry underneath.** `Init` builds OpenTelemetry tracer, meter and
  logger providers, so any OTel instrumentation (ASP.NET Core, `HttpClient`,
  SQL, gRPC) reports through it, and the `OTEL_*` environment variables work
  as usual. Errors are OTel log records in the semantic conventions
  (`exception.type`, `exception.message`, `exception.stacktrace`).
- **Sentry on top.** `CaptureException`, `CaptureMessage`, `SetUser`,
  `SetTag`, `WithScope` and the rest work as in Sentry's .NET SDK, with the
  scope carried across `await`s.
- **`ILogger` included.** `AddInstatus()` sends your logs to Instatus Logs,
  in the trace of the request that wrote them.
- **ASP.NET Core without extra code.** Every request gets its own scope, and
  exceptions a request throws are reported as unhandled, with its URL.

## Install

```bash
dotnet add package Instatus.Otel
```

It needs .NET 8 or later.

## Start

```csharp
using Instatus;

using var instatus = InstatusSdk.Init(options =>
{
    options.ApiKey = Environment.GetEnvironmentVariable("INSTATUS_API_KEY");
    options.SiteId = Environment.GetEnvironmentVariable("INSTATUS_SITE_ID");
    options.Release = Environment.GetEnvironmentVariable("GIT_SHA");
});

Run();
```

With an API key, errors, traces, logs and metrics go to
`https://otel.instatus.com`. Point them anywhere else with `Endpoint`, or with
the standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`
variables. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read too.

Disposing the result of `Init` sends what is queued and shuts the SDK down.
Queued telemetry is also sent when the process exits and after an unhandled
exception.

## ASP.NET Core

```csharp
using Instatus;

var builder = WebApplication.CreateBuilder(args);

using var instatus = InstatusSdk.Init(options =>
{
    options.ApiKey = builder.Configuration["INSTATUS_API_KEY"];
    options.SiteId = builder.Configuration["INSTATUS_SITE_ID"];
    options.Release = builder.Configuration["GIT_SHA"];
    options.Environment = builder.Environment.EnvironmentName;
    options.ConfigureTracing = tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation();
});
builder.Logging.AddInstatus();

var app = builder.Build();
```

`AddAspNetCoreInstrumentation` and `AddHttpClientInstrumentation` come from
the `OpenTelemetry.Instrumentation.AspNetCore` and
`OpenTelemetry.Instrumentation.Http` packages, for request and outgoing call
spans. Errors need neither.

Each request has its own scope, so the user you set in one never reaches
another:

```csharp
app.MapPost("/checkout", async (Order order, HttpContext context) =>
{
    InstatusSdk.SetUser(new InstatusUser { Id = context.User.FindFirst("sub")?.Value });
    await Charge(order);
    return Results.Ok();
});
```

An exception that leaves a request is reported as an unhandled error, with
the request's URL (secret query parameters filtered) and everything set on
its scope. Errors you catch go through `CaptureException`, and land on the
request's span:

```csharp
try
{
    await Charge(order);
}
catch (PaymentException exception)
{
    InstatusSdk.CaptureException(exception, scope => scope.SetTag("step", "charge"));
    return Results.Problem("Payment failed");
}
```

## Logs

```csharp
builder.Logging.AddInstatus();

logger.LogInformation("Order {OrderId} placed with {Items} items", order.Id, order.Items.Count);
```

`AddInstatus()` adds an `ILogger` provider that writes through the same
OpenTelemetry exporter as everything else, so a log written during a request
is in that request's trace, and its template values are attributes. Values
and messages go through the same filters as errors, so `{Password}` is sent
as `[Filtered]`. Your logging configuration filters it as usual, under the
`Instatus` provider name.

A log with an exception, such as `logger.LogError(exception, "Payment
failed")`, is also reported to Errors, through the same filters and scope as
`CaptureException`. The log line keeps its message.

`AddInstatus(options => ...)` also calls `Init` with those options, unless it
already ran.

Outside a host, use it on a `LoggerFactory`:

```csharp
using var loggerFactory = LoggerFactory.Create(logging => logging.AddInstatus());
```

## Unhandled exceptions

An exception nothing catches (`AppDomain.UnhandledException`) is reported as
an unhandled `fatal` error, queued telemetry is sent, then .NET prints it and
exits as it would have. A faulted task nobody awaited
(`TaskScheduler.UnobservedTaskException`) is reported as an unhandled
`error`, without changing what .NET does with it.

## Moving from Sentry

| Sentry for .NET                                   | Instatus                                           |
| ------------------------------------------------- | -------------------------------------------------- |
| `SentrySdk.Init(options => ...)`                  | `InstatusSdk.Init(options => ...)`                 |
| `builder.WebHost.UseSentry()`                     | `InstatusSdk.Init(...)` + `builder.Logging.AddInstatus()` |
| `SentrySdk.CaptureException(exception)`           | `InstatusSdk.CaptureException(exception)`          |
| `SentrySdk.CaptureMessage(message, level)`        | `InstatusSdk.CaptureMessage(message, level)`       |
| `SentrySdk.ConfigureScope(scope => ...)`          | `InstatusSdk.ConfigureScope(scope => ...)`         |
| `SentrySdk.CaptureException(exception, scope => ...)` | `InstatusSdk.CaptureException(exception, scope => ...)` |
| `options.SetBeforeSend((e, hint) => e)`           | `options.BeforeSend = e => e`                      |
| `new SentryUser { Id = ... }`                     | `new InstatusUser { Id = ... }`                    |
| `SentrySdk.FlushAsync(timeout)`                   | `InstatusSdk.Flush(timeout)`                       |

The differences:

- `SetUser`, `SetTag`, `SetTags`, `SetContext` and `SetExtra` change the
  current scope, which follows `await`s and the tasks it starts, but never
  reaches a request or job running beside it. A change made inside a task
  or an awaited method stays there, so parallel tasks never swap users or
  tags, though an error thrown there still carries it. Set the user where
  the request's code runs, not in a helper it awaits. `ConfigureScope`
  changes the global scope that every event carries under it, for values
  the whole process shares.
- `ExceptionInfo.Stacktrace` in `BeforeSend` is .NET's own text, as
  `Exception.ToString()` prints it (inner exceptions included), not Sentry's
  parsed frames.
- `ExceptionInfo.Type` is the type's full name, as .NET prints it:
  `System.InvalidOperationException`.
- Tags, contexts and extras become attributes: `SetTag("plan", "pro")` is
  `plan`, `SetContext("cart", new { Items = 3 })` is `cart.Items`, and
  `SetExtra("id", 1)` is `extra.id`.
- `Release` is `service.version`, `Environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.

## Options

| Option               | What it does                                           | Default                |
| -------------------- | ------------------------------------------------------ | ---------------------- |
| `ApiKey`, `SiteId`   | Send every signal to the Instatus collector            | `INSTATUS_*` env       |
| `Endpoint`           | Another OTLP/HTTP endpoint; `/v1/<signal>` is appended | `otel.instatus.com`    |
| `ServiceName`        | `service.name`                                         | `OTEL_SERVICE_NAME`, entry assembly name |
| `Release`            | `service.version`                                      |                        |
| `Environment`        | `deployment.environment.name`                          |                        |
| `TracesSampleRate`   | Share of traces to keep, `0` to `1`                    | `1`                    |
| `BeforeSend`         | Change an event or return `null` to drop it            |                        |
| `MaxEventsPerMinute` | Errors sent per minute                                 | `300`                  |
| `ConfigureTracing`   | Add instrumentation and `ActivitySource`s              |                        |
| `ConfigureMetrics`   | Add instrumentation and meters                         |                        |
| `ShutdownTimeout`    | How long sending waits at exit and on dispose          | 2 seconds              |
| `Enabled`            | `false` keeps the SDK quiet, for tests and local development | `true`           |
| `Debug`              | Prints why events are dropped to stderr                | `false`                |

Your own spans need their `ActivitySource` added, and metrics their meter
(`System.Runtime` is built into .NET 9 and later):

```csharp
options.ConfigureTracing = tracing => tracing.AddSource("Checkout");
options.ConfigureMetrics = metrics => metrics.AddMeter("System.Runtime");
```

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization` are
replaced with `[Filtered]` (in nested dictionaries, lists and objects too),
card numbers are filtered out of messages and stacks, and URLs lose their
credentials and secret query parameters. `BeforeSend` sees the event before
these filters run.

## Functions

### `InstatusSdk.Init(options)`

Starts the SDK and returns an `IDisposable` that sends what is queued and
stops it. Call it once, as early as you can. Calling it again replaces the
running SDK.

### `CaptureException(exception)`

Reports an exception you handled. Returns the event id.

```csharp
catch (Exception exception)
{
    InstatusSdk.CaptureException(exception, scope => scope.SetTag("step", "charge"));
}
```

### `CaptureMessage(message, level)`

Reports a message. `SeverityLevel.Error` and `SeverityLevel.Fatal` messages
are issues in Errors; lower levels are plain logs.

```csharp
InstatusSdk.CaptureMessage("Stripe webhook signature mismatch", SeverityLevel.Error);
```

### `SetUser`, `SetTag`, `SetTags`, `SetContext`, `SetExtra`

Change the current scope. `SetUser(null)` clears the user, and
`SetContext(name, null)` removes a context.

```csharp
InstatusSdk.SetUser(new InstatusUser { Id = account.Id, Email = account.Email });
InstatusSdk.SetContext("cart", new { Items = cart.Count, cart.Total });
```

### `WithScope(callback)` / `ConfigureScope(callback)`

`WithScope` runs `callback` with a copy of the current scope, so what it sets
stays inside, including across `await`s in an async callback.
`ConfigureScope` changes the global scope.

```csharp
await InstatusSdk.WithScope(async scope =>
{
    scope.SetTag("job", job.Id);
    await job.RunAsync();
});
```

### `StartSpan(name, callback)` / `StartSpanAsync(name, callback)`

Runs `callback` inside an OpenTelemetry span and ends it when `callback`
returns. An exception marks the span as failed.

```csharp
var invoice = await InstatusSdk.StartSpanAsync("build-invoice", () => BuildInvoiceAsync(order));
```

### `Flush(timeout)` / `Close(timeout)`

Send what is queued. `Close` also shuts the SDK down. Both return `false` if
`timeout` passes first; without one they wait two seconds.

```csharp
InstatusSdk.Flush(TimeSpan.FromSeconds(5));
```

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.
