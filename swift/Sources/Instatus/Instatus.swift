@_exported import Sentry

/// Starts sentry-cocoa for Instatus. Everything after `start` is Sentry's own
/// API (`SentrySDK.capture(error:)`, `SentrySDK.setUser(_:)`, …), re-exported
/// by this module, so `import Instatus` is all an app needs.
public enum Instatus {
    /// Starts reporting to the page the DSN belongs to. Returns `false`, and
    /// starts nothing, when the DSN isn't an Instatus one.
    ///
    /// `configure` gets Sentry's `Options` after the Instatus defaults, so it
    /// can turn sessions, screenshots or tracing back on. Session replay,
    /// profiling and user feedback stay off: Instatus doesn't keep them.
    @discardableResult
    public static func start(
        dsn: String,
        serviceName: String? = nil,
        configure: ((Options) -> Void)? = nil
    ) -> Bool {
        guard InstatusDsn(dsn) != nil else {
            print("[instatus] start needs an Instatus DSN, like https://<key>@api.instatus.com/sentry/1")
            return false
        }
        SentrySDK.start { options in
            configureOptions(options, dsn: dsn, serviceName: serviceName, configure: configure)
        }
        return true
    }

    static func configureOptions(
        _ options: Options,
        dsn: String,
        serviceName: String?,
        configure: ((Options) -> Void)?
    ) {
        options.dsn = dsn
        applyDefaults(to: options)
        configure?(options)
        disableUnsupportedFeatures(on: options)
        addServiceTag(serviceName, to: options)
        scrubEverySend(options)
    }

    private static func applyDefaults(to options: Options) {
        options.enableAutoSessionTracking = false
        options.tracesSampleRate = nil
        options.enableMetrics = false
        #if os(iOS) || os(tvOS) || os(visionOS)
        options.attachScreenshot = false
        options.attachViewHierarchy = false
        #endif
    }

    private static func disableUnsupportedFeatures(on options: Options) {
        #if os(iOS) || os(tvOS) || os(visionOS)
        options.sessionReplay.sessionSampleRate = 0
        options.sessionReplay.onErrorSampleRate = 0
        #endif
        #if !(os(watchOS) || os(tvOS) || os(visionOS))
        options.configureProfiling = nil
        #endif
        #if os(iOS)
        options.configureUserFeedback = nil
        #endif
    }

    // Errors names the service from this tag, as it does for the browser.
    private static func addServiceTag(_ serviceName: String?, to options: Options) {
        guard let serviceName, !serviceName.isEmpty else { return }
        let initialScope = options.initialScope
        options.initialScope = { scope in
            let configured = initialScope(scope)
            configured.setTag(value: serviceName, key: "service")
            return configured
        }
    }

    // Runs after the app's own hooks, so whatever they return is filtered.
    private static func scrubEverySend(_ options: Options) {
        let beforeSend = options.beforeSend
        options.beforeSend = { event in
            let kept = beforeSend.map { $0(event) } ?? event
            return kept.map(InstatusScrubbing.scrub)
        }
        let beforeBreadcrumb = options.beforeBreadcrumb
        options.beforeBreadcrumb = { breadcrumb in
            let kept = beforeBreadcrumb.map { $0(breadcrumb) } ?? breadcrumb
            return kept.map(InstatusScrubbing.scrub)
        }
    }
}
