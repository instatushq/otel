import XCTest
@testable import Instatus

final class ScrubbingTests: XCTestCase {
    func testFiltersCardNumbersThatPassLuhn() {
        XCTAssertEqual(InstatusScrubbing.scrubText("paid with 4111-1111-1111-1111 today"), "paid with [Filtered] today")
        XCTAssertEqual(InstatusScrubbing.scrubText("order 12345"), "order 12345")
        XCTAssertEqual(InstatusScrubbing.scrubText("at 1763600000123"), "at 1763600000123")
    }

    func testFiltersSecretsInURLs() {
        XCTAssertEqual(
            InstatusScrubbing.scrubURL("https://user:pass@app.example/a?q=shoes&token=abc&api_key=1#access_token=z"),
            "https://app.example/a?q=shoes&token=[Filtered]&api_key=[Filtered]#access_token=[Filtered]"
        )
        XCTAssertEqual(InstatusScrubbing.scrubURL("/checkout?step=2"), "/checkout?step=2")
        XCTAssertEqual(
            InstatusScrubbing.scrubURL("/pay?number=4111111111111111&step=2"),
            "/pay?number=[Filtered]&step=2"
        )
    }

    func testFiltersNestedSecrets() {
        let scrubbed = InstatusScrubbing.scrubDictionary([
            "request": ["password": "hunter2", "note": "card 4242 4242 4242 4242"],
            "headers": [["authorization": "Bearer x"]],
            "plan": "pro"
        ])
        let request = scrubbed["request"] as? [String: Any]
        XCTAssertEqual(request?["password"] as? String, "[Filtered]")
        XCTAssertEqual(request?["note"] as? String, "card [Filtered]")
        let headers = scrubbed["headers"] as? [[String: Any]]
        XCTAssertEqual(headers?.first?["authorization"] as? String, "[Filtered]")
        XCTAssertEqual(scrubbed["plan"] as? String, "pro")
    }

    func testCutsValuesPastTheDepthLimit() {
        var nested: Any = ["password": "hunter2"]
        for _ in 0..<8 { nested = ["child": nested] }
        let scrubbed = InstatusScrubbing.scrubValue(key: "value", value: nested)
        XCTAssertFalse(String(describing: scrubbed).contains("hunter2"))
        XCTAssertTrue(String(describing: scrubbed).contains("[Truncated]"))
    }
}
