import XCTest
@testable import Instatus

final class OptionsTests: XCTestCase {
    private let dsn = "https://65faec84eb7670fec24ce8966cc92cdb7f3d@api.instatus.com/sentry/1"

    private func configured(serviceName: String? = nil, _ configure: ((Options) -> Void)? = nil) -> Options {
        let options = Options()
        Instatus.configureOptions(options, dsn: dsn, serviceName: serviceName, configure: configure)
        return options
    }

    func testTurnsOffWhatInstatusDoesNotKeep() {
        let options = configured()
        XCTAssertEqual(options.dsn, dsn)
        XCTAssertFalse(options.enableAutoSessionTracking)
        XCTAssertNil(options.tracesSampleRate)
        XCTAssertFalse(options.enableMetrics)
    }

    func testLetsTheAppTurnDefaultsBackOn() {
        let options = configured { $0.enableAutoSessionTracking = true }
        XCTAssertTrue(options.enableAutoSessionTracking)
    }

    func testTagsTheService() {
        let options = configured(serviceName: "shop-ios")
        let scope = options.initialScope(Scope())
        let tags = scope.serialize()["tags"] as? [String: String]
        XCTAssertEqual(tags?["service"], "shop-ios")
    }

    func testScrubsWhatTheAppsBeforeSendReturns() throws {
        let options = configured { options in
            options.beforeSend = { event in
                event.extra = ["password": "hunter2", "note": "card 4242 4242 4242 4242"]
                return event
            }
        }
        let event = Event(level: .error)
        event.message = SentryMessage(formatted: "paid with 4111 1111 1111 1111")
        let sent = try XCTUnwrap(options.beforeSend?(event))
        XCTAssertEqual(sent.message?.formatted, "paid with [Filtered]")
        XCTAssertEqual(sent.extra?["password"] as? String, "[Filtered]")
        XCTAssertEqual(sent.extra?["note"] as? String, "card [Filtered]")
    }

    func testScrubsCardNumbersInTheRequest() throws {
        let options = configured()
        let event = Event(level: .error)
        let request = SentryRequest()
        request.url = "https://shop.example/pay?number=4111111111111111"
        request.queryString = "number=4111111111111111&step=2"
        event.request = request
        let sent = try XCTUnwrap(options.beforeSend?(event))
        XCTAssertEqual(sent.request?.url, "https://shop.example/pay?number=[Filtered]")
        XCTAssertEqual(sent.request?.queryString, "number=[Filtered]&step=2")
    }

    func testKeepsADroppedEventDropped() {
        let options = configured { $0.beforeSend = { _ in nil } }
        XCTAssertNil(options.beforeSend?(Event(level: .error)))
    }

    func testScrubsBreadcrumbs() throws {
        let options = configured()
        let breadcrumb = Breadcrumb(level: .info, category: "http")
        breadcrumb.setData(value: "https://api.example/pay?token=abc", key: "url")
        breadcrumb.setData(value: 500, key: "status_code")
        let kept = try XCTUnwrap(options.beforeBreadcrumb?(breadcrumb))
        XCTAssertEqual(kept.data?["url"] as? String, "https://api.example/pay?token=[Filtered]")
        XCTAssertEqual(kept.data?["status_code"] as? Int, 500)
    }
}
