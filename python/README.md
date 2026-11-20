# instatus-otel

Error tracking, traces and logs for Python servers, built on OpenTelemetry,
with the Sentry SDK's API. Errors show up in Instatus Errors with their
traceback, user and release; traces and logs go to Instatus next to them.

- **OpenTelemetry underneath.** Errors are OTel log records and span events
  in the semantic conventions (`exception.type`, `exception.message`,
  `exception.stacktrace`). Any OTel instrumentation you add flows through it,
  and the `OTEL_*` environment variables work as usual.
- **Sentry on top.** `init`, `capture_exception`, `set_user`, `with_scope`,
  `start_span` and the rest take the same arguments as Sentry's, so moving
  over is an import swap.
- **`logging` included.** Records from Python's `logging` module reach Logs
  with no extra code, in the trace they were written in.

Python 3.9 or later.

## Install

```bash
pip install instatus-otel
```

## Start

```python
import os

import instatus_otel

instatus_otel.init(
    api_key=os.environ["INSTATUS_API_KEY"],
    site_id=os.environ["INSTATUS_SITE_ID"],
    release=os.environ.get("GIT_SHA"),
    environment="production",
)
```

Call it once, as early as you can. `api_key` and `site_id` fall back to
`INSTATUS_API_KEY` and `INSTATUS_SITE_ID`, so `instatus_otel.init()` is
enough when those are set.

With an API key, errors, traces, logs and metrics go to
`https://otel.instatus.com` over OTLP/HTTP. Point them anywhere else with
`endpoint`, or with the standard `OTEL_EXPORTER_OTLP_ENDPOINT` /
`OTEL_EXPORTER_OTLP_HEADERS` variables. `OTEL_SERVICE_NAME` and
`OTEL_RESOURCE_ATTRIBUTES` are read too.

Uncaught exceptions, in the main thread and in other threads, are reported,
flushed, and then printed as Python would. What is queued is sent when the
process exits.

## Instrumentations

Pass OpenTelemetry instrumentors and they are registered on the SDK's
providers:

```python
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

instatus_otel.init(instrumentations=[FlaskInstrumentor(), RequestsInstrumentor()])
```

## Logging

A handler on the root logger sends `logging` records to Logs, with the
trace and span they were written in. `logger.exception(...)` carries the
traceback, so it shows up in Errors too.

```python
import logging

logging.basicConfig(level=logging.INFO)
logging.getLogger("checkout").info("Order placed", extra={"order_id": 1042})
```

`logging_level` sets the lowest level sent (`logging.INFO` by default).
Loggers still filter first: the root logger lets only `WARNING` and above
through until you lower it, as `basicConfig(level=...)` does above.

## Moving from Sentry

```diff
- import sentry_sdk
+ import instatus_otel as sentry_sdk
```

The functions below keep Sentry's signatures. The differences are:

- `event["exception"]["values"][0]["stacktrace"]` in `before_send` is the
  traceback text Python prints, which is what OpenTelemetry sends, not
  Sentry's parsed frames.
- Tags, contexts and extras become attributes: `set_tag("plan", "pro")` is
  `plan`, `set_context("cart", {"items": 3})` is `cart.items`, and
  `set_extra("id", 1)` is `extra.id`.
- `release` is `service.version`, `environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.
- Framework integrations come from OpenTelemetry's instrumentors, passed
  to `instrumentations`.

## Options

| Option                  | What it does                                         | Default              |
| ----------------------- | ---------------------------------------------------- | -------------------- |
| `api_key`, `site_id`    | Send every signal to the Instatus collector          | `INSTATUS_*` env     |
| `endpoint`              | Another OTLP/HTTP endpoint (`/v1/<signal>` is added) | `otel.instatus.com`  |
| `service_name`          | `service.name`                                       | `OTEL_SERVICE_NAME`, then `python` |
| `release`               | `service.version`                                    |                      |
| `environment`           | `deployment.environment.name`                        |                      |
| `traces_sample_rate`    | Share of traces to keep, 0 to 1                      | `1.0`                |
| `before_send`           | Change an event or return `None` to drop it          |                      |
| `max_events_per_minute` | Errors sent per minute                               | `300`                |
| `logging_level`         | Lowest `logging` level sent to Logs                  | `logging.INFO`       |
| `instrumentations`      | OpenTelemetry instrumentors to register              |                      |
| `enabled`               | `False` keeps the SDK quiet, for tests and local dev | `True`               |

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization`
are replaced with `[Filtered]`, card numbers are filtered out of messages,
tracebacks and values, and URLs lose their credentials and secret query
parameters.

## Functions

### `init(**options)`

Starts the SDK. Call it once, as early as you can.

```python
instatus_otel.init(release="api@1.4.0")
```

### `capture_exception(error=None, **scope)`

Reports an error you caught, or the one being handled when called with no
argument. Returns the event id.

```python
try:
    charge_card(order)
except Exception as error:
    instatus_otel.capture_exception(error, tags={"step": "charge"})
```

`user`, `level`, `tags`, `extras` and `contexts` apply to this event only.

### `capture_message(message, level="info")`

Reports a message. `error` and `fatal` messages are issues in Errors; lower
levels are plain logs.

```python
instatus_otel.capture_message("Stripe webhook signature mismatch", "error")
```

### `set_user(user)`

Sets who is affected. Pass `None` on sign-out.

```python
instatus_otel.set_user({"id": account.id, "email": account.email})
```

### `set_tag(key, value)` / `set_tags(tags)`

Adds attributes you can filter by.

```python
instatus_otel.set_tags({"plan": "pro", "region": "eu"})
```

### `set_context(name, context)`

Adds a group of details, flattened into `name.key` attributes.

```python
instatus_otel.set_context("cart", {"items": 3, "currency": "EUR"})
```

### `set_extra(key, value)` / `set_extras(extras)`

Adds a detail as `extra.key`.

```python
instatus_otel.set_extra("retry", 2)
```

### `with_scope()`

Gives a copy of the scope, so changes stay inside the block.

```python
with instatus_otel.with_scope() as scope:
    scope.set_tag("job", job.id)
    instatus_otel.capture_exception(error)
```

The scope lives in a context variable, so each asyncio task and each thread
keeps its own user and tags. Set at startup on the main thread, they apply
everywhere. A worker thread reuses its context from one request to the
next, so wrap each request in `with_scope()` if it sets a user; with an
OpenTelemetry instrumentor, a scope set in one request's trace is left out
of the next.

### `start_span(name, op=None, attributes=None)`

Runs the block inside an OpenTelemetry span. An exception marks the span as
failed and is raised again.

```python
with instatus_otel.start_span("build-invoice", op="job") as span:
    span.set_attribute("order.id", order.id)
    build_invoice(order)
```

### `flush(timeout=2.0)` / `close(timeout=2.0)`

Sends what is queued. `close` also shuts the SDK down. Both return `False`
if the timeout passes first.

```python
instatus_otel.flush(2.0)
```

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.
