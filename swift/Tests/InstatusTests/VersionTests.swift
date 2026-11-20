import Foundation
import XCTest
@testable import Instatus

final class VersionTests: XCTestCase {
    // One tag releases both packages, so their versions can't drift.
    func testMatchesTheJavaScriptPackage() throws {
        let packageJson = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../js/package.json")
        let data = try Data(contentsOf: packageJson)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["version"] as? String, Instatus.version)
    }
}
