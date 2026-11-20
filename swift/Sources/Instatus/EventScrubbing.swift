import Sentry

extension InstatusScrubbing {
    static func scrub(_ event: Event) -> Event {
        if let message = event.message {
            let scrubbed = SentryMessage(formatted: scrubText(message.formatted))
            scrubbed.message = message.message.map(scrubText)
            scrubbed.params = message.params?.map(scrubText)
            event.message = scrubbed
        }
        for exception in event.exceptions ?? [] {
            exception.value = exception.value.map(scrubText)
        }
        event.tags = event.tags.map(scrubStrings)
        event.extra = event.extra.map { scrubDictionary($0) }
        event.context = event.context?.mapValues { scrubDictionary($0) }
        event.breadcrumbs = event.breadcrumbs?.map(scrub)
        if let request = event.request {
            request.url = request.url.map(scrubURL)
            request.queryString = request.queryString.map { String(scrubURL("?\($0)").dropFirst()) }
            request.headers = request.headers.map(scrubStrings)
            if request.cookies != nil { request.cookies = filtered }
        }
        return event
    }

    static func scrub(_ breadcrumb: Breadcrumb) -> Breadcrumb {
        breadcrumb.message = breadcrumb.message.map(scrubText)
        for (key, value) in scrubDictionary(breadcrumb.data ?? [:]) {
            breadcrumb.setData(value: value, key: key)
        }
        return breadcrumb
    }
}
