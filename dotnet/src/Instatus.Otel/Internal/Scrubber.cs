using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;

namespace Instatus.Internal;

internal static class Scrubber
{
    public const string Filtered = "[Filtered]";
    private const string Circular = "[Circular]";
    private const string Truncated = "[Truncated]";
    private const string Unreadable = "[Unreadable]";
    private const int MaxDepth = 6;

    private static readonly Regex SensitiveKey = new(
        "pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex CardNumber = new(
        @"\b[0-9](?:[ -]?[0-9]){12,18}\b",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex UrlCredentials = new(
        "^([a-z][a-z0-9+.-]*://)[^/@?#]*@",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex UrlParam = new(
        "([?&#])([^=&#]+)=([^&#]*)",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex UrlScheme = new(
        "^[a-z][a-z0-9+.-]*://",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex UrlKey = new(
        "(^|[._-])url$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool IsSensitiveKey(string key) => SensitiveKey.IsMatch(key);

    // The Luhn check keeps timestamps and order numbers of card length.
    private static bool PassesLuhn(string digits)
    {
        var sum = 0;
        for (var index = 0; index < digits.Length; index++)
        {
            var digit = digits[digits.Length - 1 - index] - '0';
            if (index % 2 == 1) digit *= 2;
            if (digit > 9) digit -= 9;
            sum += digit;
        }
        return sum % 10 == 0;
    }

    public static string ScrubText(string text) =>
        CardNumber.Replace(text, match =>
        {
            var digits = new string(match.Value.Where(char.IsAsciiDigit).ToArray());
            return PassesLuhn(digits) ? Filtered : match.Value;
        });

    private static string Decode(string value)
    {
        try
        {
            return Uri.UnescapeDataString(value);
        }
        catch (UriFormatException)
        {
            return value;
        }
    }

    // OAuth redirects put tokens in the hash as well as the query, and a card
    // number can sit in any parameter, so URLs get the text filter too.
    public static string ScrubUrl(string url)
    {
        var withoutCredentials = UrlCredentials.Replace(url, "$1");
        var filtered = UrlParam.Replace(withoutCredentials, match =>
        {
            var key = match.Groups[2].Value;
            if (!IsSensitiveKey(Decode(key))) return match.Value;
            return $"{match.Groups[1].Value}{key}={Filtered}";
        });
        return ScrubText(filtered);
    }

    private static string ScrubString(string key, string value) =>
        UrlKey.IsMatch(key) ? ScrubUrl(value) : ScrubText(value);

    // Walks dictionaries, lists and objects, since an extra or context value
    // is serialized whole: { Request = { Password } } must lose the password too.
    public static object? ScrubValue(string key, object? value) =>
        ScrubNested(key, value, 0, new HashSet<object>(ReferenceEqualityComparer.Instance));

    private static bool HasFiltered(object? value) => value switch
    {
        string text => text.Contains(Filtered, StringComparison.Ordinal),
        Dictionary<string, object?> entries => entries.Values.Any(HasFiltered),
        List<object?> items => items.Any(HasFiltered),
        _ => false
    };

    // OpenTelemetry sends a log value as it is, or as its ToString(), so a
    // value is only replaced when a filter changed it.
    public static object? ScrubLogValue(string key, object? value)
    {
        if (IsSensitiveKey(key)) return Filtered;
        switch (value)
        {
            case null:
                return null;
            case string text:
                var looksLikeUrl = UrlKey.IsMatch(key) || UrlScheme.IsMatch(text);
                return looksLikeUrl ? ScrubUrl(text) : ScrubText(text);
            case Uri uri:
                var url = ScrubUrl(uri.OriginalString);
                return url == uri.OriginalString ? value : url;
        }
        if (!IsComposite(value)) return value;
        var scrubbed = ScrubValue(key, value);
        return HasFiltered(scrubbed) ? RecordMapper.ToAttributeValue(scrubbed) : value;
    }

    private static object? ScrubNested(string key, object? value, int depth, HashSet<object> ancestors)
    {
        if (IsSensitiveKey(key)) return Filtered;
        switch (value)
        {
            case null:
                return null;
            case string text:
                return ScrubString(key, text);
            case Uri uri:
                return ScrubUrl(uri.OriginalString);
            case Exception exception:
                return ScrubText($"{exception.GetType()}: {exception.Message}");
            case Enum or char:
                return value.ToString();
            case bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal:
                return value;
            case DateTime or DateTimeOffset or TimeSpan or Guid or DateOnly or TimeOnly:
                return value;
            case byte[]:
                return value;
        }
        if (!IsComposite(value)) return ScrubText(TextOf(value));

        // ancestors holds the values on the current path only, so a value used
        // twice (billing and shipping address) is kept and only a cycle is cut.
        if (ancestors.Contains(value)) return Circular;
        if (depth >= MaxDepth) return Truncated;
        ancestors.Add(value);
        try
        {
            return ScrubComposite(value, depth, ancestors);
        }
        finally
        {
            ancestors.Remove(value);
        }
    }

    private static object ScrubComposite(object value, int depth, HashSet<object> ancestors)
    {
        try
        {
            var entries = EntriesOf(value);
            if (entries is null)
            {
                var items = new List<object?>();
                foreach (var item in (IEnumerable)value) items.Add(ScrubNested("", item, depth + 1, ancestors));
                return items;
            }
            var scrubbed = new Dictionary<string, object?>(entries.Count);
            foreach (var (childKey, child) in entries)
                scrubbed[childKey] = ScrubNested(childKey, child, depth + 1, ancestors);
            return scrubbed;
        }
        catch (Exception)
        {
            return Unreadable;
        }
    }

    private static bool IsFrameworkType(Type type)
    {
        var name = type.Namespace;
        if (name is null) return false;
        return name == "System" || name.StartsWith("System.", StringComparison.Ordinal) ||
               name == "Microsoft" || name.StartsWith("Microsoft.", StringComparison.Ordinal);
    }

    // Only collections that are already in memory are walked: a lazy sequence
    // such as a database query would run again, or never end.
    private static bool IsMaterialized(object value) =>
        value is ICollection ||
        value.GetType().GetInterfaces().Any(type =>
            type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IReadOnlyCollection<>));

    private static bool IsComposite(object value) => value switch
    {
        IDictionary or IEnumerable<KeyValuePair<string, object?>> => true,
        IEnumerable => IsMaterialized(value),
        _ => !IsFrameworkType(value.GetType())
    };

    // The app's own objects and anonymous objects are read through their
    // public properties; framework types such as Task or Stream are not, since
    // reading them can block or have side effects.
    public static List<KeyValuePair<string, object?>>? EntriesOf(object value)
    {
        switch (value)
        {
            case IDictionary dictionary:
                var fromDictionary = new List<KeyValuePair<string, object?>>(dictionary.Count);
                foreach (DictionaryEntry entry in dictionary)
                    fromDictionary.Add(new(Convert.ToString(entry.Key) ?? "", entry.Value));
                return fromDictionary;
            case IEnumerable<KeyValuePair<string, object?>> pairs:
                return pairs.ToList();
            case IEnumerable:
                return null;
        }
        if (IsFrameworkType(value.GetType())) return null;
        var properties = value.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance);
        var fromObject = new List<KeyValuePair<string, object?>>(properties.Length);
        foreach (var property in properties)
        {
            if (!property.CanRead || property.GetIndexParameters().Length > 0) continue;
            fromObject.Add(new(property.Name, ReadProperty(property, value)));
        }
        return fromObject;
    }

    private static string TextOf(object value)
    {
        try
        {
            return value.ToString() ?? "";
        }
        catch (Exception)
        {
            return Unreadable;
        }
    }

    // A getter that throws must not turn reporting one error into a second one.
    private static object? ReadProperty(PropertyInfo property, object owner)
    {
        try
        {
            return property.GetValue(owner);
        }
        catch (Exception)
        {
            return Unreadable;
        }
    }
}
