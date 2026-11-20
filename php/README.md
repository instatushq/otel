# instatus/otel for PHP

Error tracking, logs and traces for PHP apps, built on OpenTelemetry, with
the Sentry SDK's API. Errors show up in Instatus Errors with their stack,
user, release and the trace they happened in.

- **OpenTelemetry underneath.** Errors are OTel log records and span events
  in the semantic conventions (`exception.type`, `exception.message`,
  `exception.stacktrace`), sent over OTLP/HTTP with the official
  `open-telemetry/sdk`. OTel instrumentation packages you add report through
  the same providers, and the `OTEL_*` environment variables work as usual.
- **Sentry on top.** `init`, `captureException`, `setUser`, `withScope` and
  the rest take the same arguments as Sentry's, as functions in the
  `Instatus` namespace.
- **Logs too.** A PSR-3 logger and a Monolog handler send your app's logs to
  Instatus Logs, in the trace of the request that wrote them.

Needs PHP 8.1 or later.

## Install

```bash
composer require instatus/otel
```

The OTLP exporter sends through any PSR-18 HTTP client your app already has
(Guzzle, Symfony HttpClient). If it has none, add one:

```bash
composer require guzzlehttp/guzzle
```

## Usage

```php
\Instatus\init([
    'api_key' => getenv('INSTATUS_API_KEY'),
    'site_id' => getenv('INSTATUS_SITE_ID'),
    'release' => getenv('GIT_SHA'),
    'environment' => 'production',
]);
```

Call it once per request or script, as early as you can: in
`public/index.php` after Composer's autoloader, or in a service provider's
`register`. Without the two options, `INSTATUS_API_KEY` and
`INSTATUS_SITE_ID` are read from the environment. Errors, traces, logs and
metrics go to `https://otel.instatus.com`.

Point it anywhere else with `endpoint`, or with the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` variables.
`OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read too.

Uncaught exceptions are reported at level `fatal`, and then PHP prints them
and exits as it would without the SDK. An exception handler your app set
before `init` still runs after the report. Fatal errors that are not
exceptions, such as running out of memory, are reported from a shutdown
function.

### When data is sent

PHP has no background threads, so the SDK queues errors, logs and spans and
sends each kind in one request when the script ends. Under PHP-FPM, it first
calls `fastcgi_finish_request()`, so the visitor gets the response before
anything is exported. Pass `'finish_request' => false` if your app writes
to the response from a shutdown function of its own.

Long-running workers (queue consumers, RoadRunner, Swoole) export whenever a
batch fills. Call `\Instatus\flush()` after each job to send sooner.

## Logs

```php
$logger = \Instatus\logger('billing');
$logger->warning('Retrying charge {charge}', ['charge' => $charge->id]);
```

`logger()` returns a PSR-3 logger. Context values become attributes, and an
`exception` in the context adds the `exception.*` attributes with its stack.
Placeholders under sensitive keys (`{password}`, `{token}`) are filled in as
`[Filtered]`, and a value under one of those keys is filtered out of the
message wherever it appears, which also covers messages Monolog's
`PsrLogMessageProcessor` has already filled in. Keep that processor's
`removeUsedContextFields` off: once the value has left the context, only card
numbers can still be found in the message.
With Monolog, push the handler instead:

```php
use Instatus\Logging\MonologHandler;

$monolog->pushHandler(new MonologHandler());
```

In Laravel, add a channel to `config/logging.php`:

```php
'instatus' => [
    'driver' => 'monolog',
    'handler' => Instatus\Logging\MonologHandler::class,
],
```

## Moving from Sentry

```diff
- \Sentry\init(['dsn' => $dsn]);
+ \Instatus\init(['api_key' => $apiKey, 'site_id' => $siteId]);

- \Sentry\captureException($e);
+ \Instatus\captureException($e);
```

The differences:

- `exception.stacktrace` in `before_send` is the stack as text, in PHP's
  own `#0 file(line): function()` format, not Sentry's parsed frames.
- Servers authenticate with an API key, not a DSN.
- Breadcrumbs, PHP warnings and notices aren't captured as events. Log them
  through the PSR-3 logger or Monolog handler to see them in Logs.
- Tags, contexts and extras become attributes: `setTag('plan', 'pro')` is
  `plan`, `setContext('cart', ['items' => 3])` is `cart.items`, and
  `setExtra('id', 1)` is `extra.id`.
- `release` is `service.version`, `environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.

## Options

| Option                  | What it does                                                    | Default             |
| ----------------------- | --------------------------------------------------------------- | ------------------- |
| `api_key`, `site_id`    | Send every signal to the Instatus collector                     | `INSTATUS_*` env    |
| `endpoint`              | Another OTLP/HTTP endpoint; `/v1/<signal>` is added             | `otel.instatus.com` |
| `service_name`          | `service.name`                                                  | `OTEL_SERVICE_NAME`, then `php` |
| `release`               | `service.version`                                               |                     |
| `environment`           | `deployment.environment.name`                                   |                     |
| `sample_rate`           | Share of errors to send, 0 to 1                                 | `1`                 |
| `traces_sample_rate`    | Share of traces to keep, 0 to 1                                 | `1`                 |
| `before_send`           | `fn (Event $event, ?Throwable $error): ?Event`; `null` drops it |                     |
| `ignore_exceptions`     | Exception classes (and their subclasses) not to report          |                     |
| `max_events_per_minute` | Errors sent per minute                                          | `300`               |
| `default_integrations`  | `false` turns off the exception handler and fatal error capture | `true`              |
| `span_processors`       | More OpenTelemetry span processors                              |                     |
| `shutdown_timeout`      | Seconds the final export may take before `close` reports false  | `2`                 |
| `finish_request`        | Send the PHP-FPM response before exporting                      | `true`              |
| `enabled`               | `false` keeps the SDK quiet, for tests and local dev            | `true`              |

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization` are
replaced with `[Filtered]` (in nested arrays too), card numbers are filtered
out of messages, stacks and values, and URLs lose their credentials and
secret query parameters.

## Functions

All of them live in the `Instatus` namespace.

### `init(array $options)`

Starts the SDK. A second call is ignored until `close()`.

### `captureException(Throwable $error, array $context = [])`

Reports an error you caught. Returns the event id. `$context` takes `tags`,
`extra`, `contexts`, `user` and `level` for this event only.

```php
try {
    $gateway->charge($order);
} catch (CardDeclined $e) {
    \Instatus\captureException($e, ['tags' => ['step' => 'charge']]);
}
```

### `captureMessage(string $message, string $level = 'info')`

Reports a message. `error` and `fatal` messages are issues in Errors; lower
levels are plain logs.

```php
\Instatus\captureMessage('Stripe webhook signature mismatch', 'error');
```

### `setUser(?array $user)`

Sets who is affected. Pass `null` on sign-out.

```php
\Instatus\setUser(['id' => $user->id, 'email' => $user->email]);
```

### `setTag($key, $value)` / `setTags(array $tags)`

Adds attributes you can filter by.

```php
\Instatus\setTags(['plan' => 'pro', 'region' => 'eu']);
```

### `setContext(string $name, ?array $context)`

Adds a group of details, flattened into `name.key` attributes.

```php
\Instatus\setContext('cart', ['items' => 3, 'currency' => 'EUR']);
```

### `setExtra(string $key, $value)` / `setExtras(array $extras)`

Adds a detail as `extra.key`.

### `withScope(callable $callback)`

Runs `$callback` with a copy of the scope, so changes stay inside it.

```php
\Instatus\withScope(function (\Instatus\Scope $scope) use ($job, $e) {
    $scope->setTag('job', $job->id);
    \Instatus\captureException($e);
});
```

### `startSpan(string $name, callable $callback, iterable $attributes = [])`

Runs `$callback` inside an OpenTelemetry span and ends it when the callback
returns. An exception marks the span as failed and is rethrown. Errors
captured inside it are recorded on the span and carry its trace id.

```php
$invoice = \Instatus\startSpan('build-invoice', fn () => $builder->build($order));
```

### `flush(float $timeout = 2.0)` / `close(float $timeout = 2.0)`

Sends what is queued. `close` also shuts the SDK down. Both return `false`
if an export failed or took longer than `$timeout` seconds. The SDK closes
itself when the script ends, so most apps never call them.

`$timeout` bounds the whole call, not each export: logs go first, then
traces and metrics, each request may take only the time left (at most 5
seconds), a retry the collector asks to delay past it is dropped, and what
hasn't been sent when it runs out stays unsent. A retry after a network error
can still wait up to about 0.4 seconds first. This holds with Guzzle,
Symfony HttpClient and Buzz; `php-http/curl-client` drops the fraction of a
second, so it can't stop a request with less than a second left. Exports configured only through `OTEL_EXPORTER_OTLP_*` use the OTel
SDK's own client with `OTEL_EXPORTER_OTLP_TIMEOUT` per request, so for them
the limit only skips the signals whose turn comes after it.

### `logger(string $name = 'app')`

Returns a PSR-3 logger for Instatus Logs.

## How errors reach Instatus

| From            | Sent to                                      | Authenticated by                        |
| --------------- | -------------------------------------------- | --------------------------------------- |
| PHP, API key    | `otel.instatus.com/v1/{logs,traces,metrics}` | `Authorization: Bearer`, site id header |
| PHP, `endpoint` | `<endpoint>/v1/{logs,traces,metrics}`        | Whatever that collector expects         |

Requests are OTLP/HTTP protobuf, gzipped when `ext-zlib` is loaded.

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.

```bash
composer install
composer test      # PHPUnit
composer analyse   # PHPStan
```
