# github.com/instatushq/otel/go

Error tracking, logs, traces and metrics for Go services, built on
OpenTelemetry, with the Sentry SDK's API. Errors show up in Instatus Errors
with their Go stack, user, tags and release.

- **OpenTelemetry underneath.** `Init` sets the global tracer, logger and
  meter providers, so any OTel instrumentation (`otelhttp`, `otelgrpc`,
  `otelsql`) reports through it, and the `OTEL_*` environment variables work
  as usual. Errors are OTel log records in the semantic conventions
  (`exception.type`, `exception.message`, `exception.stacktrace`).
- **Sentry on top.** `CaptureException`, `CaptureMessage`, `SetUser`,
  `SetTag`, `Recover` and the rest work as in `sentry-go`, with the scope
  carried on `context.Context`.
- **`slog` included.** `instatus.Logger()` sends your logs to Instatus Logs,
  in the trace of the request that wrote them.

## Install

```bash
go get github.com/instatushq/otel/go
```

It needs Go 1.23 or later.

## Start

```go
package main

import (
	"context"
	"log"
	"os"

	instatus "github.com/instatushq/otel/go"
)

func main() {
	shutdown, err := instatus.Init(instatus.Options{
		APIKey:  os.Getenv("INSTATUS_API_KEY"),
		SiteID:  os.Getenv("INSTATUS_SITE_ID"),
		Release: os.Getenv("GIT_SHA"),
	})
	if err != nil {
		log.Fatal(err)
	}
	defer shutdown(context.Background())
	defer instatus.Recover()

	run()
}
```

With an API key, errors, traces, logs and metrics go to
`https://otel.instatus.com`. Point them anywhere else with `Endpoint`, or with
the standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`
variables. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read too.

Call `shutdown` before the process exits: Go has no exit hook, so anything
still queued is lost otherwise.

## HTTP servers

Wrap your handler with `otelhttp` for request spans, and give each request
its own scope:

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

func withInstatus(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := instatus.WithContext(r.Context(), "request", instatus.Context{
			"method": r.Method,
			"url":    r.URL.String(),
		})
		defer instatus.RecoverWithContext(ctx)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

http.ListenAndServe(":8080", otelhttp.NewHandler(withInstatus(mux), "server"))
```

Inside a handler, errors you capture land on the request's span and carry
its scope:

```go
func checkout(w http.ResponseWriter, r *http.Request) {
	ctx := instatus.WithUser(r.Context(), instatus.User{ID: account.ID})
	if err := charge(ctx, order); err != nil {
		instatus.CaptureException(ctx, err)
		http.Error(w, "payment failed", http.StatusBadGateway)
	}
}
```

## Logs

```go
logger := instatus.Logger()
logger.InfoContext(ctx, "order placed", "order", order.ID, "items", len(order.Items))
```

`Logger` returns a `*slog.Logger` on the OpenTelemetry `slog` bridge.
`NewSlogHandler(name)` gives you the `slog.Handler` instead, to combine with
a handler that still prints to stderr, or to name the instrumentation scope.
Logging with a context puts the record in that request's trace. Log records
go through the same filters as errors, in groups too, and any string value
that starts with a scheme (`https://…`) is filtered as a URL.

## Panics

`defer instatus.Recover()` reports a panic as an unhandled `fatal` error,
flushes, then panics again with the same value, so Go prints it and exits as
it would have. `RecoverWithContext(ctx)` does the same with that context's
scope and span. A panic in another goroutine needs its own deferred
`Recover`, as Go only recovers a panic in the goroutine that raised it.

## Moving from Sentry

| sentry-go                                | instatus                                   |
| ---------------------------------------- | ------------------------------------------ |
| `sentry.Init(sentry.ClientOptions{...})` | `instatus.Init(instatus.Options{...})`     |
| `sentry.CaptureException(err)`           | `instatus.CaptureException(ctx, err)`      |
| `sentry.CaptureMessage(msg)`             | `instatus.CaptureMessage(ctx, msg, level)` |
| `sentry.ConfigureScope(fn)`              | `instatus.ConfigureScope(fn)`              |
| `hub.Scope().SetTag(k, v)` per request   | `ctx = instatus.WithTag(ctx, k, v)`        |
| `defer sentry.Recover()`                 | `defer instatus.Recover()`                 |
| `sentry.Flush(2 * time.Second)`          | `instatus.Flush(ctx)`                      |

The differences:

- The scope lives on `context.Context` instead of a hub: `WithUser`,
  `WithTag`, `WithContext` and `WithExtra` return a context that carries the
  change, on top of the global scope that `SetUser`, `SetTag` and the other
  setters change.
- `Exception.Stacktrace` in `BeforeSend` is Go's own stack text, as
  `runtime/debug.Stack` prints it, not Sentry's parsed frames.
- `Exception.Type` is the error's type as `%T` prints it, skipping the
  wrappers `fmt.Errorf` and `errors.Join` add: `fmt.Errorf("load: %w", err)`
  around an `*fs.PathError` is `*fs.PathError`.
- Tags, contexts and extras become attributes: `SetTag("plan", "pro")` is
  `plan`, `SetContext("cart", instatus.Context{"items": 3})` is
  `cart.items`, and `SetExtra("id", 1)` is `extra.id`.
- `Release` is `service.version`, `Environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.

## Options

| Option               | What it does                                           | Default                |
| -------------------- | ------------------------------------------------------ | ---------------------- |
| `APIKey`, `SiteID`   | Send every signal to the Instatus collector            | `INSTATUS_*` env       |
| `Endpoint`           | Another OTLP/HTTP endpoint; `/v1/<signal>` is appended | `otel.instatus.com`    |
| `ServiceName`        | `service.name`                                         | `OTEL_SERVICE_NAME`, executable name |
| `Release`            | `service.version`                                      |                        |
| `Environment`        | `deployment.environment.name`                          |                        |
| `TracesSampleRate`   | Share of traces to keep, `instatus.SampleRate(0.25)`   | all                    |
| `BeforeSend`         | Change an event or return `nil` to drop it             |                        |
| `MaxEventsPerMinute` | Errors sent per minute                                 | `300`                  |
| `MetricsInterval`    | How often metrics are exported                         | OTel's default (60 s)  |
| `Disabled`           | Keeps the SDK quiet, for tests and local development   | `false`                |
| `Debug`              | Prints why events are dropped to stderr                | `false`                |

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization` are
replaced with `[Filtered]` (in nested maps, slices and structs too), card
numbers are filtered out of messages and stacks, and URLs under a `url` key
lose their credentials and secret query parameters. `BeforeSend` sees the
event before these filters run.

## Functions

### `Init(options)`

Starts the SDK and returns a `shutdown` function that flushes and stops it.
Call it once, as early as you can.

### `CaptureException(ctx, err)`

Reports an error you handled. Returns the event id.

```go
if err := chargeCard(ctx, order); err != nil {
	instatus.CaptureException(instatus.WithTag(ctx, "step", "charge"), err)
}
```

### `CaptureMessage(ctx, message, level)`

Reports a message. `LevelError` and `LevelFatal` messages are issues in
Errors; lower levels are plain logs.

```go
instatus.CaptureMessage(ctx, "Stripe webhook signature mismatch", instatus.LevelError)
```

### `WithUser`, `WithTag`, `WithTags`, `WithContext`, `WithExtra`, `WithScope`

Return a context whose events carry the change. The context you pass is left
as it was, so concurrent requests never see each other's scope.

```go
ctx = instatus.WithUser(ctx, instatus.User{ID: account.ID, Email: account.Email})
ctx = instatus.WithScope(ctx, func(scope *instatus.Scope) {
	scope.SetTag("job", job.ID)
	scope.SetExtra("attempt", job.Attempt)
})
```

### `SetUser`, `SetTag`, `SetTags`, `SetContext`, `SetExtra`, `ConfigureScope`

Change the global scope, which every event carries under the context's.
`SetUser(instatus.User{})` clears the user, and `SetContext(name, nil)`
removes a context.

```go
instatus.SetTags(map[string]string{"region": "eu", "plan": "pro"})
```

### `StartSpan(ctx, name, fn)`

Runs `fn` inside an OpenTelemetry span and ends it when `fn` returns. An
error or a panic marks the span as failed.

```go
err := instatus.StartSpan(ctx, "build-invoice", func(ctx context.Context) error {
	return buildInvoice(ctx, order)
})
```

### `Flush(ctx)` / `Close(ctx)`

Send what is queued. `Close` also shuts the SDK down. Both return `false` if
`ctx` ends first, or after two seconds when it has no deadline.

```go
instatus.Flush(ctx)
```

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.
