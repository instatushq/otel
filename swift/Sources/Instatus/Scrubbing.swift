import Foundation

/// The same filters `@instatus/otel` applies in the browser and Node, so a
/// value scrubbed there is scrubbed here too.
public enum InstatusScrubbing {
    public static let filtered = "[Filtered]"

    private static let maxDepth = 6
    private static let sensitiveKey = try! NSRegularExpression(
        pattern: "pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature",
        options: [.caseInsensitive]
    )
    private static let cardNumber = try! NSRegularExpression(pattern: "\\b\\d(?:[ -]?\\d){12,18}\\b")
    private static let urlCredentials = try! NSRegularExpression(
        pattern: "^([a-z][a-z0-9+.-]*://)[^/@?#]*@",
        options: [.caseInsensitive]
    )
    private static let urlParam = try! NSRegularExpression(pattern: "([?&#])([^=&#]+)=([^&#]*)")

    public static func isSensitiveKey(_ key: String) -> Bool {
        sensitiveKey.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil
    }

    /// Card numbers only when they pass the Luhn check, so timestamps and
    /// order numbers of card length are kept.
    public static func scrubText(_ text: String) -> String {
        replacing(cardNumber, in: text) { match in
            passesLuhn(match.filter(\.isNumber)) ? filtered : match
        }
    }

    /// A card number can sit in any parameter (`?number=4111…`), not only
    /// under a secret-sounding name, so URLs get the text filter too.
    public static func scrubURL(_ url: String) -> String {
        let range = NSRange(url.startIndex..., in: url)
        let withoutCredentials = urlCredentials.stringByReplacingMatches(
            in: url, range: range, withTemplate: "$1"
        )
        let withoutSecrets = replacing(urlParam, in: withoutCredentials) { match in
            let separator = String(match.prefix(1))
            let pair = match.dropFirst()
            guard let equals = pair.firstIndex(of: "=") else { return match }
            let key = String(pair[..<equals])
            let decoded = key.removingPercentEncoding ?? key
            return isSensitiveKey(decoded) ? "\(separator)\(key)=\(filtered)" : match
        }
        return scrubText(withoutSecrets)
    }

    /// Walks dictionaries and arrays, so `["request": ["password": …]]`
    /// loses the password too. Past the depth limit a value is cut.
    public static func scrubValue(key: String, value: Any, depth: Int = 0) -> Any {
        if isSensitiveKey(key) { return filtered }
        if let text = value as? String {
            return key == "url" ? scrubURL(text) : scrubText(text)
        }
        let isNested = value is [String: Any] || value is [Any]
        if isNested && depth >= maxDepth { return "[Truncated]" }
        if let dictionary = value as? [String: Any] {
            return scrubDictionary(dictionary, depth: depth + 1)
        }
        if let array = value as? [Any] {
            return array.map { scrubValue(key: "", value: $0, depth: depth + 1) }
        }
        return value
    }

    public static func scrubDictionary(_ dictionary: [String: Any], depth: Int = 0) -> [String: Any] {
        dictionary.reduce(into: [:]) { result, entry in
            result[entry.key] = scrubValue(key: entry.key, value: entry.value, depth: depth)
        }
    }

    public static func scrubStrings(_ dictionary: [String: String]) -> [String: String] {
        dictionary.reduce(into: [:]) { result, entry in
            result[entry.key] = isSensitiveKey(entry.key) ? filtered : scrubText(entry.value)
        }
    }

    private static func passesLuhn(_ digits: String) -> Bool {
        var sum = 0
        for (index, character) in digits.reversed().enumerated() {
            guard var digit = character.wholeNumberValue else { return false }
            if index % 2 == 1 { digit *= 2 }
            if digit > 9 { digit -= 9 }
            sum += digit
        }
        return sum % 10 == 0
    }

    private static func replacing(
        _ pattern: NSRegularExpression,
        in text: String,
        with transform: (String) -> String
    ) -> String {
        let matches = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
        var result = text
        for match in matches.reversed() {
            guard let range = Range(match.range, in: result) else { continue }
            result.replaceSubrange(range, with: transform(String(result[range])))
        }
        return result
    }
}
