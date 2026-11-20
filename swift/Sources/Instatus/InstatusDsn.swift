import Foundation

/// The Instatus Sentry-format DSN, `https://<key>@api.instatus.com/sentry/1`,
/// where the key is the page's browser key written as 36 hex characters.
public struct InstatusDsn: Equatable, Sendable {
    public let origin: String
    public let publicKey: String
    public let projectId: String

    public init?(_ value: String) {
        guard
            let components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(),
            scheme == "https" || scheme == "http",
            let host = components.host, !host.isEmpty,
            let user = components.user?.lowercased(),
            InstatusDsn.isPublicKey(user),
            let projectId = components.path.split(separator: "/").last.map(String.init),
            !projectId.isEmpty
        else { return nil }

        let port = components.port.map { ":\($0)" } ?? ""
        origin = "\(scheme)://\(host)\(port)"
        publicKey = user
        self.projectId = projectId
    }

    private static func isPublicKey(_ value: String) -> Bool {
        value.count == 36 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}
