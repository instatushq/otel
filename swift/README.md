# Instatus for Swift

The `Instatus` library starts [sentry-cocoa](https://github.com/getsentry/sentry-cocoa)
9 for Instatus. It checks the DSN is an Instatus one, turns off what Instatus
doesn't keep (sessions, screenshots, view hierarchies, tracing, metrics,
session replay, profiling, user feedback), and filters secrets, card numbers
and URL credentials out of every event and breadcrumb after your own
`beforeSend` and `beforeBreadcrumb`.

```swift
import Instatus

Instatus.start(
  dsn: "https://<key>@api.instatus.com/sentry/1",
  serviceName: "shop-ios"
) { options in
  options.environment = "production"
}
```

`import Instatus` re-exports Sentry, so `SentrySDK.capture(error:)`,
`SentrySDK.setUser(_:)`, `SentrySDK.addBreadcrumb(_:)` and the rest work as
in Sentry's docs.

Release builds strip symbols, so app frames show as `<redacted>` until dSYM
upload is supported.
