// swift-tools-version:6.0

import PackageDescription

let package = Package(
    name: "Instatus",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v9), .visionOS(.v1)],
    products: [
        .library(name: "Instatus", targets: ["Instatus"])
    ],
    dependencies: [
        .package(url: "https://github.com/getsentry/sentry-cocoa", from: "9.0.0")
    ],
    targets: [
        .target(
            name: "Instatus",
            dependencies: [.product(name: "Sentry", package: "sentry-cocoa")],
            path: "swift/Sources/Instatus"
        ),
        .testTarget(
            name: "InstatusTests",
            dependencies: ["Instatus"],
            path: "swift/Tests/InstatusTests"
        )
    ]
)
