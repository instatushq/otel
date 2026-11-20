# instatus-otel

Error tracking for Ruby, built on OpenTelemetry, with the Sentry SDK's API.
Errors show up in Instatus Errors with their backtrace, user and release, and
your traces, logs and metrics go to Instatus alongside them.

- **OpenTelemetry underneath.** Errors are OTel log records and span events
  in the semantic conventions (`exception.type`, `exception.message`,
  `exception.stacktrace`). Any OTel instrumentation you add flows through
  it, and the `OTEL_*` environment variables work as usual.
- **Sentry on top.** `init`, `capture_exception`, `set_user`, `with_scope`
  and the rest take the same arguments as `sentry-ruby`'s, so moving over is
  mostly a rename.
- **Rails and Rack.** In a Rails app the gem subscribes to `Rails.error` and
  gives each request its own scope. Any other Rack app adds one middleware.

## Install

```ruby
# Gemfile
gem "instatus-otel"
```

Ruby 3.1 or later.

## Start

```ruby
require "instatus/otel"

Instatus.init do |config|
  config.api_key = ENV["INSTATUS_API_KEY"]
  config.site_id = ENV["INSTATUS_SITE_ID"]
  config.release = ENV["GIT_SHA"]
  config.environment = "production"
end
```

With an API key, errors, traces, logs and metrics go to
`https://otel.instatus.com` over OTLP/HTTP. `api_key` and `site_id` fall back
to `INSTATUS_API_KEY` and `INSTATUS_SITE_ID`, so with those set,
`Instatus.init` alone is enough.

Point it anywhere else with `endpoint`, or with the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` variables.
`OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read too.

An exception that ends the process is reported at `fatal` level, flushed,
and then Ruby prints it and exits as usual. `exit` and signals such as
`SIGTERM` aren't reported.

### Rails

Add the gem and put `Instatus.init` in `config/initializers/instatus.rb`.
Errors Rails reports, unhandled request and job errors and those you pass to
`Rails.error.report` or `Rails.error.handle`, reach Instatus with
`exception.handled` set as Rails says. Unhandled controller errors are
reported this way from Rails 7.1.

Each request runs in its own scope, so `Instatus.set_user` in a controller
never reaches the next request on the same thread.

To send `Rails.logger` to Logs too (Rails 7.1 or later):

```ruby
Rails.logger.broadcast_to(Instatus.logger)
```

### Rack and Sinatra

```ruby
use Instatus::Otel::RackMiddleware
```

The middleware gives each request its own scope, adds its URL (with
secrets filtered out) and reports what the app raises.

### Instrumentations

Install the OTel instrumentation gems you want, require them, and name them
in `instrumentations`:

```ruby
require "opentelemetry/instrumentation/all"

Instatus.init do |config|
  config.instrumentations = :all
end
```

`instrumentations` takes `:all`, a list of names such as
`["OpenTelemetry::Instrumentation::Rack"]`, or a hash of names to their
options, as `OpenTelemetry::SDK.configure`'s `use` does.

## Moving from Sentry

```diff
- gem "sentry-ruby"
- gem "sentry-rails"
+ gem "instatus-otel"
```

```diff
- Sentry.init do |config|
-   config.dsn = ENV["SENTRY_DSN"]
+ Instatus.init do |config|
+   config.api_key = ENV["INSTATUS_API_KEY"]
+   config.site_id = ENV["INSTATUS_SITE_ID"]
```

Then `Sentry.` becomes `Instatus.`. The differences:

- `event.exception` in `before_send` is one value with `type`, `value`,
  `stacktrace` (Ruby's backtrace text) and `handled`, not Sentry's list of
  parsed frames. The raised exception is in `hint[:exception]`.
- Breadcrumbs, session tracking and profiling aren't included.
- Tags, contexts and extras become attributes: `set_tag("plan", "pro")` is
  `plan`, `set_context("cart", { items: 3 })` is `cart.items`, and
  `set_extra("id", 1)` is `extra.id`.
- `release` is `service.version`, `environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.

## Options

| Option                    | What it does                                           | Default             |
| ------------------------- | ------------------------------------------------------ | ------------------- |
| `api_key`, `site_id`      | Send every signal to the Instatus collector            | `INSTATUS_*` env    |
| `endpoint`                | Another OTLP/HTTP endpoint (`/v1/<signal>` is added)   | `otel.instatus.com` |
| `service_name`            | `service.name`                                         | `OTEL_SERVICE_NAME`, then `ruby` |
| `release`                 | `service.version`                                      |                     |
| `environment`             | `deployment.environment.name`                          |                     |
| `sample_rate`             | Share of errors to send, 0 to 1                        | `1`                 |
| `traces_sample_rate`      | Share of traces to keep, 0 to 1                        | `1`                 |
| `before_send`             | Change an event or return `nil` to drop it             |                     |
| `excluded_exceptions`     | Exception classes (or their names) never reported      | `[]`                |
| `max_events_per_minute`   | Errors sent per minute                                 | `300`               |
| `instrumentations`        | OpenTelemetry instrumentations to install              |                     |
| `metrics_export_interval` | Seconds between metric exports                         | `60`                |
| `shutdown_timeout`        | Seconds to flush at exit                               | `2`                 |
| `debug`                   | Print why events are dropped                           | `false`             |
| `enabled`                 | `false` keeps the SDK quiet, for tests and local dev   | `true`              |

Every option can also be passed to `init` as a keyword:
`Instatus.init(release: "1.4.0")`.

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization` are
replaced with `[Filtered]` (in nested hashes and arrays too), card numbers
are filtered out of messages and backtraces, and URLs lose their
credentials and secret query parameters. `before_send` runs before these
filters, so it sees the original values.

## Functions

### `Instatus.init { |config| }`

Starts the SDK. Call it once, as early as you can.

### `Instatus.capture_exception(error, **context)`

Reports an error you rescued. Returns the event id.

```ruby
begin
  charge_card(order)
rescue Stripe::CardError => e
  Instatus.capture_exception(e, tags: { step: "charge" })
end
```

`context` takes `tags:`, `extra:`, `user:`, `contexts:` and `level:`, and a
block gets a copy of the scope for this event only.

### `Instatus.capture_message(message, level: :info)`

Reports a message. `:error` and `:fatal` messages are issues in Errors;
lower levels are plain logs.

```ruby
Instatus.capture_message("Stripe webhook signature mismatch", level: :error)
```

### `Instatus.set_user(user)`

Sets who is affected. Pass `nil` on sign-out.

```ruby
Instatus.set_user(id: account.id, email: account.email)
```

### `Instatus.set_tag(key, value)` / `Instatus.set_tags(tags)`

Adds attributes you can filter by.

```ruby
Instatus.set_tags(plan: "pro", region: "eu")
```

### `Instatus.set_context(name, context)`

Adds a group of details, flattened into `name.key` attributes.

```ruby
Instatus.set_context("cart", { items: 3, currency: "EUR" })
```

### `Instatus.set_extra(key, value)`

Adds a detail as `extra.key`.

### `Instatus.with_scope { |scope| }`

Runs the block with a copy of the scope, so changes stay inside it.

```ruby
Instatus.with_scope do |scope|
  scope.set_tag("job", job.id)
  Instatus.capture_exception(error)
end
```

The scope lives in the OpenTelemetry context, so it is per fiber. Outside
`with_scope` each thread gets its own copy of the global scope; the main
thread uses the global scope itself.

### `Instatus.start_span(name, attributes: nil) { |span| }`

Runs the block inside an OpenTelemetry span and ends it when the block
returns. An exception marks the span as failed and is raised again.

```ruby
invoice = Instatus.start_span("build-invoice") { build_invoice(order) }
```

Errors captured inside a span carry its trace and span id, and are added to
it as an `exception` event.

### `Instatus.logger`

A `::Logger` whose records go to Logs, with the active span's trace id.

```ruby
Instatus.logger.info("Charged #{order.id}")
```

`Instatus::Otel::Logger.new($stdout)` writes to a device as well.

### `Instatus.flush(timeout = 2)` / `Instatus.close(timeout = 2)`

Sends what is queued. `close` also shuts the SDK down. Both return `false`
if the timeout, in seconds, passes first. Short scripts and jobs that call
`exit!` should flush before they end; a normal exit flushes on its own.

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.
