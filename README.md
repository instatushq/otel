# Instatus OpenTelemetry SDKs

Errors, logs and traces for [Instatus](https://instatus.com), built on
OpenTelemetry, with the Sentry SDK's API.

| Package                                 | Install                                                     | For                                 |
| --------------------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| [`@instatus/otel`](js)                  | `npm install @instatus/otel`                                | Browser, Node, React, React Native  |
| [`Instatus`](swift)                     | Swift Package Manager: `https://github.com/instatushq/otel` | iOS, macOS, tvOS, watchOS, visionOS |
| [`instatus-otel`](python)               | `pip install instatus-otel`                                 | Python                              |
| [`github.com/instatushq/otel/go`](go)   | `go get github.com/instatushq/otel/go`                      | Go                                  |
| [`com.instatus:instatus-otel`](java)    | Maven or Gradle                                             | Java, Kotlin and other JVM apps     |
| [`Instatus.Otel`](dotnet)               | `dotnet add package Instatus.Otel`                          | .NET                                |
| [`instatus-otel`](ruby)                 | `bundle add instatus-otel`                                  | Ruby, Rails                         |
| [`instatus/otel`](php)                  | `composer require instatus/otel`                            | PHP                                 |

Android apps use [sentry-android](js/README.md#android-sentry-android) with
the Instatus DSN.

Every package shares one version, and each release publishes them together.

Browsers and mobile apps report errors with the page's public DSN:

```ts
import { init } from '@instatus/otel/browser'

init({ dsn: 'https://<key>@api.instatus.com/sentry/1' })
```

Servers send errors, logs, traces and metrics with an API key:

```python
import os
import instatus_otel

instatus_otel.init(api_key=os.environ["INSTATUS_API_KEY"], site_id="<page id>")
```

Each folder's README covers its options and functions.

## Contributing

Issues are welcome. This repository is published from Instatus's monorepo,
so changes are made there and synced here.

## License

MIT
