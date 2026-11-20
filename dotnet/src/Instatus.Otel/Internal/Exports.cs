using System;
using System.Collections.Generic;
using System.Linq;

namespace Instatus.Internal;

internal enum Signal
{
    Logs,
    Traces,
    Metrics
}

// Url null leaves the OTLP exporter to read OTEL_EXPORTER_OTLP_* itself.
internal sealed record SignalExport(Uri? Url, IReadOnlyDictionary<string, string> Headers)
{
    public string HeaderString => string.Join(",", Headers.Select(pair => $"{pair.Key}={pair.Value}"));
}

internal static class Exports
{
    public const string DefaultEndpoint = "https://otel.instatus.com";

    private static readonly Signal[] Signals = { Signal.Logs, Signal.Traces, Signal.Metrics };

    private static readonly IReadOnlyDictionary<string, string> NoHeaders = new Dictionary<string, string>();

    private static string PathOf(Signal signal) => signal.ToString().ToLowerInvariant();

    private static bool HasEnvEndpoint(Func<string, string?> getenv, Signal signal) =>
        !string.IsNullOrEmpty(getenv($"OTEL_EXPORTER_OTLP_{PathOf(signal).ToUpperInvariant()}_ENDPOINT")) ||
        !string.IsNullOrEmpty(getenv("OTEL_EXPORTER_OTLP_ENDPOINT"));

    public static Uri SignalUrl(string endpoint, Signal signal) =>
        new($"{endpoint.TrimEnd('/')}/v1/{PathOf(signal)}");

    private static Uri? UrlFor(string? endpoint, Func<string, string?> getenv, Signal signal)
    {
        if (!string.IsNullOrEmpty(endpoint)) return SignalUrl(endpoint, signal);
        if (HasEnvEndpoint(getenv, signal)) return null;
        return SignalUrl(DefaultEndpoint, signal);
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrEmpty(value));

    // An API key sends every signal to the collector. Without one, only an
    // endpoint or the standard OTEL_EXPORTER_OTLP_* variables export anything.
    public static Dictionary<Signal, SignalExport> Resolve(InstatusOptions options, Func<string, string?> getenv)
    {
        var apiKey = FirstNonEmpty(options.ApiKey, getenv("INSTATUS_API_KEY"));
        var siteId = FirstNonEmpty(options.SiteId, getenv("INSTATUS_SITE_ID"));
        var resolved = new Dictionary<Signal, SignalExport>();
        if (apiKey is not null)
        {
            var headers = new Dictionary<string, string> { ["Authorization"] = $"Bearer {apiKey}" };
            if (siteId is not null) headers["X-Instatus-Site-Id"] = siteId;
            foreach (var signal in Signals)
                resolved[signal] = new SignalExport(UrlFor(options.Endpoint, getenv, signal), headers);
            return resolved;
        }
        foreach (var signal in Signals)
        {
            if (!string.IsNullOrEmpty(options.Endpoint))
                resolved[signal] = new SignalExport(SignalUrl(options.Endpoint, signal), NoHeaders);
            else if (HasEnvEndpoint(getenv, signal))
                resolved[signal] = new SignalExport(null, NoHeaders);
        }
        return resolved;
    }
}
