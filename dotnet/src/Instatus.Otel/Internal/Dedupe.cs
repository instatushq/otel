using System;
using System.Runtime.CompilerServices;

namespace Instatus.Internal;

// Same as Sentry's Dedupe integration: an event identical to the one just
// sent is a re-throw, or a handler and a global hook both reporting one error.
internal sealed class Dedupe
{
    private readonly object gate = new();
    private string? previous;

    private static string SignatureOf(InstatusEvent source)
    {
        if (source.Exception is { } exception)
            return $"{exception.Type}|{exception.Value}|{exception.Stacktrace}";
        return $"message|{source.Message}";
    }

    public bool IsDuplicate(InstatusEvent source)
    {
        var signature = SignatureOf(source);
        lock (gate)
        {
            var duplicate = signature == previous;
            previous = signature;
            return duplicate;
        }
    }
}

internal static class CapturedExceptions
{
    private static readonly ConditionalWeakTable<Exception, object> Captured = new();

    public static bool WasCaptured(Exception? exception) =>
        exception is not null && Captured.TryGetValue(exception, out _);

    public static void MarkCaptured(Exception? exception)
    {
        if (exception is not null) Captured.AddOrUpdate(exception, true);
    }
}
