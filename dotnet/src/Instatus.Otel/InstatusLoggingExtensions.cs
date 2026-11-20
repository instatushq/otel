using System;
using System.Collections.Generic;
using System.Threading;
using Instatus.Internal;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Instatus;

/// <summary>Sends <see cref="ILogger"/> logs to Instatus Logs.</summary>
public static class InstatusLoggingExtensions
{
    /// <summary>
    /// Sends this app's <see cref="ILogger"/> logs through the exporter <see cref="InstatusSdk.Init(Action{InstatusOptions})"/>
    /// set up, in the trace of the request that wrote them. A log with an exception also reports the exception to Errors.
    /// Pass <paramref name="configure"/> to call Init here, unless it already ran.
    /// </summary>
    public static ILoggingBuilder AddInstatus(this ILoggingBuilder builder, Action<InstatusOptions>? configure = null)
    {
        if (configure is not null && !InstatusSdk.IsEnabled) InstatusSdk.Init(configure);
        builder.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, InstatusLoggerProvider>());
        return builder;
    }
}

[ProviderAlias("Instatus")]
internal sealed class InstatusLoggerProvider : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new InstatusLogger(categoryName);

    public void Dispose()
    {
    }
}

// Init may run before or after the host builds its loggers, and again after
// Close, so each log finds the SDK's current logger factory.
internal sealed class InstatusLogger : ILogger
{
    private sealed record Binding(Telemetry Owner, ILogger Logger);

    private readonly string category;
    private Binding? binding;

    public InstatusLogger(string category) => this.category = category;

    private ILogger? Inner()
    {
        var telemetry = InstatusSdk.CurrentTelemetry;
        if (telemetry is null) return null;
        var current = Volatile.Read(ref binding);
        if (current is not null && ReferenceEquals(current.Owner, telemetry)) return current.Logger;
        var created = new Binding(telemetry, telemetry.LoggerFactory.CreateLogger(category));
        Volatile.Write(ref binding, created);
        return created.Logger;
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None && Inner() is { } logger && logger.IsEnabled(logLevel);

    // ASP.NET Core logs the exceptions a request throws before its diagnostic
    // event fires, so those are reported here, as the unhandled errors they are.
    private bool IsFrameworkFailure(LogLevel logLevel) =>
        logLevel >= LogLevel.Error && category.StartsWith("Microsoft.AspNetCore.", StringComparison.Ordinal);

    // The exception goes through the SDK, so it is filtered, deduplicated and
    // carries the scope like a captured one; the log line keeps its message,
    // filtered the same way as its values.
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        var logger = Inner();
        if (logger is null || !logger.IsEnabled(logLevel)) return;
        if (exception is not null) InstatusSdk.CaptureLoggedException(exception, logLevel, !IsFrameworkFailure(logLevel));
        if (state is IEnumerable<KeyValuePair<string, object?>> values)
        {
            var filtered = FilteredLogState.From(values, () => formatter(state, exception));
            logger.Log(logLevel, eventId, filtered, null, FilteredLogState.Format);
            return;
        }
        logger.Log(logLevel, eventId, state, null, (value, _) => Scrubber.ScrubText(formatter(value, exception)));
    }
}
