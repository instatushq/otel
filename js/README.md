# @instatus/otel

Error tracking for the web, Node, React Native, iOS and Android, built on
OpenTelemetry, with the Sentry SDK's API. Errors show up in Instatus Errors
with their stack, breadcrumbs, user and release, and mobile errors with the
devices and OS versions they hit.

- **OpenTelemetry underneath.** Errors are OTel log records and span events
  in the semantic conventions (`exception.type`, `exception.message`,
  `exception.stacktrace`). Any OTel instrumentation you add flows through it,
  and the `OTEL_*` environment variables work as usual.
- **Sentry on top.** `init`, `captureException`, `setUser`, `withScope`,
  `startSpan` and the rest take the same arguments as Sentry's, so moving
  over is an import swap.
- **Mobile through Sentry's SDKs.** React Native, iOS and Android report
  through Sentry's own mobile SDKs, which catch native crashes, pointed at
  Instatus. Errors stores them as the same OpenTelemetry records.
- **Import only what you use.** Each platform is its own entry point, and
  everything is a plain named export, so bundlers drop what you don't call.

| Import                           | For                                 | Size (min + gzip) |
| -------------------------------- | ----------------------------------- | ----------------- |
| `@instatus/otel/browser`         | Browser errors and breadcrumbs      | ~10 KB            |
| `@instatus/otel/browser/tracing` | Browser errors plus OTel web traces | ~30 KB            |
| `@instatus/otel/node`            | Node errors, traces, logs, metrics  | server only       |
| `@instatus/otel/react`           | `ErrorBoundary` for React           | tiny              |
| `@instatus/otel/react-native`    | React Native JS and native crashes  | Sentry's RN SDK   |

| Platform     | Use                                                                        |
| ------------ | -------------------------------------------------------------------------- |
| Browser      | [`@instatus/otel/browser`](#browser)                                       |
| Node         | [`@instatus/otel/node`](#node)                                             |
| React Native | [`@instatus/otel/react-native`](#react-native) with `@sentry/react-native` |
| iOS, macOS   | [the `Instatus` Swift package](#ios-macos-tvos-watchos-and-visionos)       |
| Android      | [sentry-android with the Instatus DSN](#android-sentry-android)            |

## Install

```bash
npm install @instatus/otel
```

For React Native, add `@sentry/react-native` too.

## Browser

```ts
import { init } from '@instatus/otel/browser'

init({
  dsn: 'https://<key>@api.instatus.com/sentry/1',
  release: 'web@1.4.0',
  environment: 'production'
})
```

The DSN is on the page's Errors setup screen. It holds the page's public
browser key, so it is safe to ship in your bundle; Instatus only takes
errors with it, from the origins you allow.

Uncaught errors, unhandled rejections and breadcrumbs (clicks, navigation,
`fetch`/XHR, `console.error`/`warn`) are recorded automatically.

## Node

```ts
import { init } from '@instatus/otel/node'

init({
  apiKey: process.env.INSTATUS_API_KEY,
  siteId: process.env.INSTATUS_SITE_ID,
  release: process.env.GIT_SHA
})
```

With an API key, errors, traces, logs and metrics go to
`https://otel.instatus.com`. With only a `dsn`, Node reports errors the way
the browser does.

Point it anywhere else with `endpoint`, or with the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` variables.
`OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read too. Add OTel
instrumentations as you would with the OTel SDK:

```ts
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { init } from '@instatus/otel/node'

init({ apiKey, siteId, instrumentations: [new HttpInstrumentation()] })
```

Uncaught exceptions are reported, flushed, and then the process exits with
code 1, as Node would. If your app has its own `uncaughtException`
listener, it decides instead.

## React Native

```bash
npm install @instatus/otel @sentry/react-native
```

```tsx
import { init, wrap } from '@instatus/otel/react-native'

init({ dsn: 'https://<key>@api.instatus.com/sentry/1' })

export default wrap(App)
```

On React Native, `@instatus/otel` wraps Sentry's React Native SDK instead of
running its own pipeline, because catching native crashes takes the native
SDKs that ship inside it (sentry-cocoa on iOS, sentry-android on Android).
JS errors, unhandled rejections and native crashes all reach the same DSN.
Expo works too; add `@sentry/react-native/expo` to your app config plugins
as Sentry's Expo guide says.

`init` takes Sentry's React Native options and changes a few defaults, since
Instatus keeps errors only:

- Session replay, profiling and user feedback are left out, even if the
  options or integrations for them are set.
- Release health sessions, screenshots and view hierarchies are off. Set
  `attachScreenshot` or `enableAutoSessionTracking` to turn them back on;
  Instatus doesn't store them yet.
- `tracesSampleRate` is unset, so no transactions are recorded.
- JS events and breadcrumbs get the same filters as the other entries
  (secrets, card numbers, URL credentials), after your own `beforeSend` and
  `beforeBreadcrumb`. Native crash reports are sent by sentry-cocoa and
  sentry-android without passing through JS, so they skip these filters.

The entry exports the same functions as `@instatus/otel/browser`
(`captureException`, `captureMessage`, `setUser`, `setTag`, `setContext`,
`addBreadcrumb`, `withScope`, `flush` and the rest), plus `wrap`,
`ErrorBoundary`, `withErrorBoundary`, `TouchEventBoundary` and
`nativeCrash`, all from Sentry. Import `ErrorBoundary` from here, not from
`@instatus/otel/react`, so it reports through the React Native SDK.

```tsx
import { captureException, ErrorBoundary } from '@instatus/otel/react-native'
;<ErrorBoundary fallback={<Text>Something went wrong.</Text>}>
  <Checkout />
</ErrorBoundary>
```

The release defaults to `<bundle id>@<version>+<build>`, and Errors names the
service after the bundle id. Pass `serviceName` to choose another.

### Source maps

Release bundles are minified, so upload the bundle and its source map for
each release. With Hermes, upload the composed map that
`@sentry/react-native`'s build scripts write next to the bundle.

```bash
tar -cz index.android.bundle index.android.bundle.map |
  curl --fail-with-body -X POST \
    "https://api.instatus.com/v1/<page id>/sourcemaps?release=com.acme.shop@2.4.0%2B118" \
    -H "Authorization: Bearer $INSTATUS_API_KEY" \
    -H "Content-Type: application/gzip" --data-binary @-
```

The bundle is `index.android.bundle` on Android and `main.jsbundle` on iOS.

## iOS and Android

Native apps run on Sentry's own SDKs with the Instatus DSN.

### iOS, macOS, tvOS, watchOS and visionOS

Add `https://github.com/instatushq/otel` with Swift Package Manager and pick
the `Instatus` library. It wraps sentry-cocoa 9 and starts it with the same
defaults and filters as this package:

```swift
import Instatus

@main
struct ShopApp: App {
  init() {
    Instatus.start(dsn: "https://<key>@api.instatus.com/sentry/1")
  }
}
```

Crashes, uncaught `NSException`s and app hangs are reported on the next
launch. Everything else is Sentry's API, which `import Instatus` brings in:
`SentrySDK.capture(error:)`, `SentrySDK.setUser(_:)` and the rest. Pass
`serviceName:` to name the service, and `configure:` to change Sentry's
options; session replay, profiling and user feedback stay off.

### Android (sentry-android)

```kotlin
// app/build.gradle.kts
dependencies {
  implementation("io.sentry:sentry-android:8.+")
}
```

```xml
<!-- AndroidManifest.xml, inside <application> -->
<meta-data android:name="io.sentry.dsn"
  android:value="https://<key>@api.instatus.com/sentry/1" />
<meta-data android:name="io.sentry.auto-session-tracking.enable"
  android:value="false" />
```

The SDK starts itself from the manifest and reports uncaught exceptions,
ANRs and NDK crashes. `Sentry.captureException(e)` and `Sentry.setUser(...)`
work as in Sentry's docs.

### What Errors shows

Native stacks keep each frame's binary, address and function, and the
issue's side panel lists the devices and OS versions it hits. Two things
need symbol files that Instatus doesn't take yet:

- **iOS release builds** strip symbols, so app frames show addresses until
  dSYM upload lands. Debug builds and system frames are named on the device.
- **Android builds with R8 or ProGuard** show obfuscated class and method
  names until mapping upload lands. Builds without minification are fine.

## Moving from Sentry

```diff
- import * as Sentry from '@sentry/browser'
+ import * as Sentry from '@instatus/otel/browser'
```

```diff
- import * as Sentry from '@sentry/react-native'
+ import * as Sentry from '@instatus/otel/react-native'
```

On iOS, swap `SentrySDK.start` for `Instatus.start(dsn:)`. On Android, keep
sentry-android and swap the DSN for your Instatus one.

Everything below keeps Sentry's signature. On the web and Node, the
differences are (React Native and native apps keep Sentry's event shape):

- `exception.values[0].stacktrace` in `beforeSend` is the runtime's stack
  text, which is what OpenTelemetry sends, not Sentry's parsed frames.
- Session replay, profiling and user feedback aren't included.
- Tags, contexts and extras become attributes: `setTag('plan', 'pro')` is
  `plan`, `setContext('cart', { items: 3 })` is `cart.items`, and
  `setExtra('id', 1)` is `extra.id`.
- `release` is `service.version`, `environment` is
  `deployment.environment.name`, and the user's id (or email, or username)
  is `enduser.id`.

## Options

| Option                | What it does                                              | Default             |
| --------------------- | --------------------------------------------------------- | ------------------- |
| `dsn`                 | Instatus DSN; errors go to the page it belongs to         |                     |
| `apiKey`, `siteId`    | Node only: send every signal to the Instatus collector    | `INSTATUS_*` env    |
| `endpoint`            | Node only: another OTLP/HTTP endpoint                     | `otel.instatus.com` |
| `logsEndpoint`        | Browser: any OTLP/HTTP logs endpoint instead of Instatus  |                     |
| `serviceName`         | `service.name`                                            | `web` / package     |
| `release`             | `service.version`                                         |                     |
| `environment`         | `deployment.environment.name`                             |                     |
| `sampleRate`          | Share of errors to send, 0 to 1                           | `1`                 |
| `tracesSampleRate`    | Share of traces to keep, 0 to 1                           | `1`                 |
| `beforeSend`          | Change an event or return `null` to drop it               |                     |
| `beforeBreadcrumb`    | Change a breadcrumb or return `null` to drop it           |                     |
| `ignoreErrors`        | Strings or patterns matched against the message           |                     |
| `maxBreadcrumbs`      | Breadcrumbs kept per event                                | `30`                |
| `maxEventsPerPage`    | Browser: errors sent per page load                        | `50`                |
| `maxEventsPerMinute`  | Node: errors sent per minute                              | `300`               |
| `integrations`        | Add integrations, or a function that filters the defaults | defaults            |
| `defaultIntegrations` | `false` turns off global handlers and breadcrumbs         |                     |
| `instrumentations`    | OpenTelemetry instrumentations to register                |                     |
| `enabled`             | `false` keeps the SDK quiet, for tests and local dev      | `true`              |

Every event is checked before it is sent: the same error twice in a row is
sent once, values under keys like `password`, `token` or `authorization` are
replaced with `[Filtered]`, card numbers are filtered out of messages, URLs
lose their credentials and secret query parameters, and request breadcrumbs
keep only the path.

These filters run in this package's JavaScript. Native iOS and Android apps
that use Sentry's SDKs directly, and native crashes from React Native, need
their own `beforeSend` to filter anything sensitive.

## Functions

### `init(options)`

Starts the SDK. Call it once, as early as you can.

```ts
init({ dsn, release: 'web@1.4.0' })
```

### `captureException(error, context?)`

Reports an error you caught. Returns the event id.

```ts
try {
  await chargeCard(order)
} catch (error) {
  captureException(error, { tags: { step: 'charge' } })
}
```

### `captureMessage(message, level?)`

Reports a message. `error` and `fatal` messages are issues in Errors; lower
levels are plain logs.

```ts
captureMessage('Stripe webhook signature mismatch', 'error')
```

### `setUser(user)`

Sets who is affected. Pass `null` on sign-out.

```ts
setUser({ id: account.id, email: account.email })
```

### `setTag(key, value)` / `setTags(tags)`

Adds attributes you can filter by.

```ts
setTags({ plan: 'pro', region: 'eu' })
```

### `setContext(name, context)`

Adds a group of details, flattened into `name.key` attributes.

```ts
setContext('cart', { items: 3, currency: 'EUR' })
```

### `setExtra(key, value)` / `setExtras(extras)`

Adds a detail as `extra.key`.

```ts
setExtra('retry', 2)
```

### `addBreadcrumb(breadcrumb)`

Records a step for the trail Errors shows before a browser error. Clicks,
navigation, requests and warnings appear there.

```ts
addBreadcrumb({
  category: 'auth',
  level: 'warning',
  message: 'Token refresh failed'
})
```

### `withScope(callback)`

Runs `callback` with a copy of the scope, so changes stay inside it. On Node
the scope follows the callback across `await`.

```ts
withScope((scope) => {
  scope.setTag('job', job.id)
  captureException(error)
})
```

### `startSpan(options, callback)`

Runs `callback` inside an OpenTelemetry span and ends it when the callback
returns or its promise settles. Errors mark the span as failed.

```ts
const invoice = await startSpan({ name: 'build-invoice', op: 'job' }, () =>
  buildInvoice(order)
)
```

`startInactiveSpan` and `startSpanManual` work as in Sentry; `getActiveSpan`
returns the current OTel span.

### `flush(timeoutMs?)` / `close(timeoutMs?)`

Sends what is queued. `close` also shuts the SDK down. Both resolve to
`false` if the timeout passes first.

```ts
await flush(2000)
```

### `breadcrumbsIntegration(options)` / `globalHandlersIntegration()`

The browser's default integrations. Pass one to change it:

```ts
init({ dsn, integrations: [breadcrumbsIntegration({ console: false })] })
```

On Node the defaults are `onUncaughtExceptionIntegration()` and
`onUnhandledRejectionIntegration()`.

### `ErrorBoundary`

From `@instatus/otel/react`. Reports render errors with the component stack
and shows `fallback` instead.

```tsx
import { ErrorBoundary } from '@instatus/otel/react'
;<ErrorBoundary fallback={<p>Something went wrong.</p>}>
  <Checkout />
</ErrorBoundary>
```

`withErrorBoundary(Component, props)` wraps a component the same way.

## Browser tracing

```ts
import { init } from '@instatus/otel/browser/tracing'

init({
  dsn,
  tracePropagationTargets: [/^https:\/\/api\.example\.com/],
  tracesEndpoint: 'https://collector.example.com/v1/traces'
})
```

`fetch` and XHR get spans and send `traceparent` to the URLs you list, so a
browser request and your API's spans share one trace, and errors carry the
trace id. Browser spans go only to a `tracesEndpoint` you give: the Instatus
collector takes secret API keys, which don't belong in a browser.

## How errors reach Instatus

| From                       | Sent to                                      | Authenticated by                        |
| -------------------------- | -------------------------------------------- | --------------------------------------- |
| Browser, DSN               | `api.instatus.com/v1/browser/<key>/v1/logs`  | Public browser key + allowed origins    |
| Node, DSN                  | the same                                     | Public browser key                      |
| Node, API key              | `otel.instatus.com/v1/{logs,traces,metrics}` | `Authorization: Bearer`, site id header |
| React Native, iOS, Android | `api.instatus.com/sentry/api/1/envelope/`    | Public browser key in the DSN           |

The browser key intake takes OTLP/JSON and keeps exception records only.
It groups minified browser stacks by their source-mapped frame, so upload
source maps for each release.

The mobile SDKs send Sentry envelopes. The backend's Sentry intake keeps
their error events and drops sessions, transactions and attachments.

## Contributing

Issues are welcome at [instatushq/otel](https://github.com/instatushq/otel/issues). This repository is published from Instatus's monorepo, so changes are made there and synced here.
