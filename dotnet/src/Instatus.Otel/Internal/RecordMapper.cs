using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Instatus.Internal;

internal sealed record ErrorLogRecord(
    DateTimeOffset Timestamp,
    int SeverityNumber,
    string SeverityText,
    LogLevel LogLevel,
    string Body,
    IReadOnlyList<KeyValuePair<string, object?>> Attributes)
{
    public object? Attribute(string key) => Attributes.FirstOrDefault(pair => pair.Key == key).Value;
}

internal static class RecordMapper
{
    public const string DefaultExceptionType = "Error";
    private const string ReservedPrefix = "instatus.";
    private const int MaxValueLength = 8192;
    private const int MaxStackLength = 32000;

    private static readonly JsonSerializerOptions Json = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private static readonly Dictionary<string, string> UserKeys = new()
    {
        ["username"] = "name",
        ["ip_address"] = "ip"
    };

    private sealed record Severity(int Number, string Text, LogLevel LogLevel);

    private static Severity SeverityOf(SeverityLevel level) => level switch
    {
        SeverityLevel.Fatal => new(21, "FATAL", LogLevel.Critical),
        SeverityLevel.Error => new(17, "ERROR", LogLevel.Error),
        SeverityLevel.Warning => new(13, "WARN", LogLevel.Warning),
        SeverityLevel.Info => new(9, "INFO", LogLevel.Information),
        SeverityLevel.Debug => new(5, "DEBUG", LogLevel.Debug),
        _ => new(17, "ERROR", LogLevel.Error)
    };

    public static string Cut(string text, int limit)
    {
        if (text.Length <= limit) return text;
        var end = limit;
        if (char.IsLowSurrogate(text[end])) end--;
        return text[..end];
    }

    private static string Stringify(object value)
    {
        try
        {
            return JsonSerializer.Serialize(value, Json);
        }
        catch (Exception)
        {
            return value.ToString() ?? "";
        }
    }

    public static object? ToAttributeValue(object? value) => value switch
    {
        null => null,
        string text => Cut(text, MaxValueLength),
        bool flag => flag,
        sbyte or byte or short or ushort or int or uint or long => Convert.ToInt64(value, CultureInfo.InvariantCulture),
        ulong number when number <= long.MaxValue => (long)number,
        ulong number => number.ToString(CultureInfo.InvariantCulture),
        float or double or decimal => Convert.ToDouble(value, CultureInfo.InvariantCulture),
        DateTime time => time.ToString("O", CultureInfo.InvariantCulture),
        DateTimeOffset time => time.ToString("O", CultureInfo.InvariantCulture),
        IFormattable formattable => Cut(formattable.ToString(null, CultureInfo.InvariantCulture), MaxValueLength),
        _ => Cut(Stringify(value), MaxValueLength)
    };

    private sealed class Attributes
    {
        private readonly List<string> keys = new();
        private readonly Dictionary<string, object> values = new();

        public void Set(string key, object value)
        {
            if (!values.ContainsKey(key)) keys.Add(key);
            values[key] = value;
        }

        public bool Has(string key) => values.ContainsKey(key);

        public void Put(string key, object? value)
        {
            if (key.StartsWith(ReservedPrefix, StringComparison.Ordinal)) return;
            var attribute = ToAttributeValue(Scrubber.ScrubValue(key, value));
            if (attribute is null || attribute is "") return;
            Set(key, attribute);
        }

        public IEnumerable<KeyValuePair<string, object>> Entries() =>
            keys.Select(key => new KeyValuePair<string, object>(key, values[key]));
    }

    private static string? EndUserId(InstatusUser user)
    {
        if (!string.IsNullOrEmpty(user.Id)) return user.Id;
        if (!string.IsNullOrEmpty(user.Email)) return user.Email;
        return string.IsNullOrEmpty(user.Username) ? null : user.Username;
    }

    private static void PutUser(Attributes target, InstatusUser? user)
    {
        if (user is null) return;
        var endUser = EndUserId(user);
        if (endUser is not null) target.Set("enduser.id", Cut(endUser, MaxValueLength));
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("id", user.Id),
            new("email", user.Email),
            new("username", user.Username),
            new("ip_address", user.IpAddress)
        };
        fields.AddRange(user.Other.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => new KeyValuePair<string, string?>(pair.Key, pair.Value)));
        foreach (var (key, value) in fields)
            target.Put($"user.{UserKeys.GetValueOrDefault(key, key)}", value);
    }

    private static void PutContext(Attributes target, string name, object? context)
    {
        var entries = context is null ? null : Scrubber.EntriesOf(context);
        if (entries is null)
        {
            target.Put(name, context);
            return;
        }
        foreach (var (key, value) in entries) target.Put($"{name}.{key}", value);
    }

    private static Attributes MetadataOf(InstatusEvent source)
    {
        var metadata = new Attributes();
        foreach (var (key, value) in source.Tags.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            metadata.Put(key, value);
        foreach (var (name, context) in source.Contexts.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            PutContext(metadata, name, context);
        foreach (var (key, value) in source.Extra.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            metadata.Put($"extra.{key}", value);
        PutUser(metadata, source.User);
        return metadata;
    }

    private static string ExceptionTypeOf(ExceptionInfo exception) =>
        string.IsNullOrEmpty(exception.Type) ? DefaultExceptionType : exception.Type;

    private static void PutException(Attributes target, InstatusEvent source, bool isError)
    {
        var exception = source.Exception;
        if (exception is null)
        {
            if (!isError || string.IsNullOrEmpty(source.Message)) return;
            target.Set("exception.type", DefaultExceptionType);
            target.Set("exception.message", Cut(Scrubber.ScrubText(source.Message), MaxValueLength));
            return;
        }
        target.Set("exception.type", ExceptionTypeOf(exception));
        target.Set("exception.message", Cut(Scrubber.ScrubText(exception.Value), MaxValueLength));
        if (!string.IsNullOrEmpty(exception.Stacktrace))
            target.Set("exception.stacktrace", Cut(Scrubber.ScrubText(exception.Stacktrace), MaxStackLength));
        target.Set("exception.handled", exception.Handled);
    }

    private static void PutRequestUrl(Attributes target, string? requestUrl)
    {
        if (string.IsNullOrEmpty(requestUrl)) return;
        var url = Scrubber.ScrubUrl(requestUrl);
        target.Set("url.full", Cut(url, MaxValueLength));
        if (Uri.TryCreate(url, UriKind.Absolute, out var parsed)) target.Set("url.path", parsed.AbsolutePath);
    }

    private static string BodyOf(InstatusEvent source)
    {
        var exception = source.Exception;
        if (exception is null) return Scrubber.ScrubText(source.Message ?? "");
        var type = ExceptionTypeOf(exception);
        var message = Scrubber.ScrubText(exception.Value);
        return message.Length == 0 ? type : $"{type}: {message}";
    }

    // Tags, contexts and extras become log attributes, and errors follow the
    // OpenTelemetry exception conventions so Instatus Errors groups them.
    public static ErrorLogRecord ToRecord(InstatusEvent source)
    {
        var severity = SeverityOf(source.Level);
        var record = new Attributes();
        PutException(record, source, severity.Number >= 17);
        record.Set("log.record.uid", source.EventId);
        PutRequestUrl(record, source.RequestUrl);

        // The error's own fields come first and win: receivers cap attribute
        // counts, and metadata must never push the exception out.
        foreach (var (key, value) in MetadataOf(source).Entries())
        {
            if (!record.Has(key)) record.Set(key, value);
        }

        return new ErrorLogRecord(
            source.Timestamp,
            severity.Number,
            severity.Text,
            severity.LogLevel,
            BodyOf(source),
            record.Entries().Select(pair => new KeyValuePair<string, object?>(pair.Key, pair.Value)).ToList());
    }
}
