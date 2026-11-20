import XCTest
@testable import Instatus

final class InstatusDsnTests: XCTestCase {
    private let key = "65faec84eb7670fec24ce8966cc92cdb7f3d"

    func testReadsTheInstatusDsn() throws {
        let dsn = try XCTUnwrap(InstatusDsn("https://\(key)@api.instatus.com/sentry/1"))
        XCTAssertEqual(dsn.origin, "https://api.instatus.com")
        XCTAssertEqual(dsn.publicKey, key)
        XCTAssertEqual(dsn.projectId, "1")
    }

    func testKeepsALocalPortAndUppercaseKeys() throws {
        let dsn = try XCTUnwrap(InstatusDsn("http://\(key.uppercased())@localhost:1111/sentry/1"))
        XCTAssertEqual(dsn.origin, "http://localhost:1111")
        XCTAssertEqual(dsn.publicKey, key)
    }

    func testRefusesDsnsItCannotUse() {
        XCTAssertNil(InstatusDsn("not a url"))
        XCTAssertNil(InstatusDsn("https://api.instatus.com/sentry/1"))
        XCTAssertNil(InstatusDsn("https://\(key)@api.instatus.com"))
        XCTAssertNil(InstatusDsn("ftp://\(key)@api.instatus.com/1"))
        XCTAssertNil(InstatusDsn("https://abc123@o1.ingest.sentry.io/1"))
    }

    func testStartRefusesASentryDsn() {
        XCTAssertFalse(Instatus.start(dsn: "https://abc123@o1.ingest.sentry.io/1"))
    }
}
