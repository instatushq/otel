using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Threading.Tasks;
using Instatus.Internal;
using Microsoft.Extensions.Logging;

namespace Instatus;

/// <summary>
/// The Instatus distribution of OpenTelemetry for .NET, with the Sentry SDK's API for errors.
/// </summary>
public static partial class InstatusSdk
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan Minute = TimeSpan.FromMinutes(1);
    private static readonly object InitGate = new();

    private static volatile Session? active;

    private sealed class Session : IDisposable
    {
        public required Client Client { get; init; }
        public required Telemetry Telemetry { get; init; }
        public required TimeSpan ShutdownTimeout { get; init; }
        public AspNetCoreErrors? AspNetCore { get; init; }
        public string? LastEventId { get; set; }

        public void Dispose() => Close(this, ShutdownTimeout);
    }

    internal static Telemetry? CurrentTelemetry => active?.Telemetry;

    /// <summary>True between <see cref="Init(Action{InstatusOptions})"/> and <see cref="Close()"/>.</summary>
    public static bool IsEnabled => active is not null;

    /// <summary>The id of the last event sent, if any.</summary>
    public static string? LastEventId => active?.LastEventId;

    /// <summary>
    /// Starts the SDK: OpenTelemetry tracer, meter and logger providers exporting to Instatus, and the hooks that
    /// report unhandled exceptions. Dispose the result before the process exits to send what is queued.
    /// Calling it again closes the previous SDK first.
    /// </summary>
    public static IDisposable Init(Action<InstatusOptions>? configure = null)
    {
        var options = new InstatusOptions();
        configure?.Invoke(options);
        return Init(options);
    }

    /// <inheritdoc cref="Init(Action{InstatusOptions})"/>
    public static IDisposable Init(InstatusOptions options)
    {
        lock (InitGate)
        {
            if (active is { } previous) Close(previous, previous.ShutdownTimeout);
            var session = Start(options, Environment.GetEnvironmentVariable);
            active = session;
            return session;
        }
    }

    private static Session Start(InstatusOptions options, Func<string, string?> getenv)
    {
        var exports = new Dictionary<Signal, SignalExport>();
        if (options.Enabled)
        {
            exports = Exports.Resolve(options, getenv);
            if (!exports.ContainsKey(Signal.Logs))
                Console.Error.WriteLine("[instatus] Init needs an ApiKey (or INSTATUS_API_KEY) or an OTLP endpoint");
        }
        var telemetry = Telemetry.Create(options, exports, getenv);
        var limit = options.MaxEventsPerMinute > 0 ? options.MaxEventsPerMinute : 300;
        var session = new Session
        {
            Client = new Client(options, telemetry, new RateCap(limit, Minute)),
            Telemetry = telemetry,
            ShutdownTimeout = options.ShutdownTimeout,
            AspNetCore = options.Enabled ? AspNetCoreErrors.Start() : null
        };
        if (options.Enabled)
        {
            AppDomain.CurrentDomain.FirstChanceException += OnFirstChanceException;
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
            TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
        }
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
        return session;
    }

    private static void OnFirstChanceException(object? sender, FirstChanceExceptionEventArgs args) =>
        Scopes.Remember(args.Exception);

    private static void OnUnhandledException(object? sender, UnhandledExceptionEventArgs args)
    {
        var session = active;
        if (session is null || args.ExceptionObject is not Exception exception) return;
        CaptureUnhandled(exception, SeverityLevel.Fatal);
        session.Telemetry.Flush(session.ShutdownTimeout);
    }

    // A faulted task nobody awaited reports an AggregateException around the
    // real one; its type would put every such error in a single issue.
    private static Exception Unwrap(AggregateException aggregate)
    {
        var flattened = aggregate.Flatten();
        if (flattened.InnerExceptions.Count == 1) return flattened.InnerExceptions[0];
        return aggregate;
    }

    private static void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs args) =>
        CaptureUnhandled(Unwrap(args.Exception), SeverityLevel.Error);

    private static void OnProcessExit(object? sender, EventArgs args)
    {
        var session = active;
        session?.Telemetry.Flush(session.ShutdownTimeout);
    }

    private static string ExceptionText(Exception exception)
    {
        try
        {
            return exception.ToString();
        }
        catch (Exception)
        {
            return $"{exception.GetType()}: {exception.Message}{Environment.NewLine}{exception.StackTrace}";
        }
    }

    internal static InstatusEvent EventFromException(Exception exception, bool handled, SeverityLevel level) => new()
    {
        Level = level,
        OriginalException = exception,
        Exception = new ExceptionInfo
        {
            Type = exception.GetType().ToString(),
            Value = exception.Message,
            Stacktrace = ExceptionText(exception),
            Handled = handled
        }
    };

    private static Scope ScopeOf(InstatusEvent source)
    {
        if (source.Exception is { Handled: false } && source.OriginalException is { } exception)
            return Scopes.SnapshotWhereThrown(exception);
        return Scopes.Snapshot();
    }

    private static string Capture(InstatusEvent source, Action<Scope>? configureScope)
    {
        var session = active;
        if (session is null) return "";
        var scope = ScopeOf(source);
        configureScope?.Invoke(scope);
        scope.ApplyTo(source);
        var eventId = session.Client.Capture(source);
        session.LastEventId = eventId;
        return eventId;
    }

    internal static void CaptureUnhandled(Exception exception, SeverityLevel level) =>
        Capture(EventFromException(exception, false, level), null);

    private static SeverityLevel LevelOf(LogLevel logLevel) => logLevel switch
    {
        LogLevel.Critical => SeverityLevel.Fatal,
        LogLevel.Error => SeverityLevel.Error,
        LogLevel.Warning => SeverityLevel.Warning,
        LogLevel.Information => SeverityLevel.Info,
        _ => SeverityLevel.Debug
    };

    internal static void CaptureLoggedException(Exception exception, LogLevel logLevel, bool handled) =>
        Capture(EventFromException(exception, handled, LevelOf(logLevel)), null);

    /// <summary>Reports an exception you handled. Returns its event id.</summary>
    public static string CaptureException(Exception exception) =>
        Capture(EventFromException(exception, true, SeverityLevel.Error), null);

    /// <summary>Reports an exception you handled, with changes to the scope for this event only. Returns its event id.</summary>
    public static string CaptureException(Exception exception, Action<Scope> configureScope) =>
        Capture(EventFromException(exception, true, SeverityLevel.Error), configureScope);

    /// <summary>
    /// Reports a message. <see cref="SeverityLevel.Error"/> and <see cref="SeverityLevel.Fatal"/> messages are issues
    /// in Errors; lower levels are plain logs. Returns its event id.
    /// </summary>
    public static string CaptureMessage(string message, SeverityLevel level = SeverityLevel.Info) =>
        Capture(new InstatusEvent { Message = message, Level = level }, null);

    /// <summary>Sets the user of the current scope. <c>null</c> clears it.</summary>
    public static void SetUser(InstatusUser? user)
    {
        Scopes.Change(scope => scope.SetUser(user));
        var activity = Activity.Current;
        var id = new[] { user?.Id, user?.Email, user?.Username }.FirstOrDefault(value => !string.IsNullOrEmpty(value));
        if (activity is { IsAllDataRequested: true } && id is not null) activity.SetTag("enduser.id", id);
    }

    /// <summary>Sets a tag on the current scope, sent as an attribute under its own key.</summary>
    public static void SetTag(string key, string value) => Scopes.Change(scope => scope.SetTag(key, value));

    /// <summary>Sets several tags on the current scope.</summary>
    public static void SetTags(IEnumerable<KeyValuePair<string, string>> tags)
    {
        var copy = tags.ToList();
        Scopes.Change(scope => scope.SetTags(copy));
    }

    /// <summary>Sets a context on the current scope, sent as <c>&lt;name&gt;.&lt;key&gt;</c> attributes. <c>null</c> removes it.</summary>
    public static void SetContext(string name, object? context) => Scopes.Change(scope => scope.SetContext(name, context));

    /// <summary>Sets an extra on the current scope, sent as an <c>extra.&lt;key&gt;</c> attribute.</summary>
    public static void SetExtra(string key, object? value) => Scopes.Change(scope => scope.SetExtra(key, value));

    /// <summary>Changes the global scope, which every event carries under the current one.</summary>
    public static void ConfigureScope(Action<Scope> configure) => configure(Scopes.Global);

    /// <summary>
    /// Runs <paramref name="callback"/> with a copy of the current scope. Changes inside it, and events captured
    /// inside it, stay in the copy.
    /// </summary>
    public static void WithScope(Action<Scope> callback) =>
        Scopes.With<object?>(scope =>
        {
            callback(scope);
            return null;
        });

    /// <inheritdoc cref="WithScope(Action{Scope})"/>
    public static T WithScope<T>(Func<Scope, T> callback) => Scopes.With(callback);

    private static void Fail(Activity? activity, Exception exception) =>
        activity?.SetStatus(ActivityStatusCode.Error, Scrubber.ScrubText(exception.Message));

    /// <summary>Runs <paramref name="callback"/> inside an OpenTelemetry span. An exception marks the span as failed.</summary>
    public static T StartSpan<T>(string name, Func<T> callback)
    {
        using var activity = Telemetry.Source.StartActivity(name);
        try
        {
            return callback();
        }
        catch (Exception exception)
        {
            Fail(activity, exception);
            throw;
        }
    }

    /// <inheritdoc cref="StartSpan{T}(string, Func{T})"/>
    public static void StartSpan(string name, Action callback) =>
        StartSpan<object?>(name, () =>
        {
            callback();
            return null;
        });

    /// <summary>Awaits <paramref name="callback"/> inside an OpenTelemetry span. An exception marks the span as failed.</summary>
    public static async Task<T> StartSpanAsync<T>(string name, Func<Task<T>> callback)
    {
        using var activity = Telemetry.Source.StartActivity(name);
        try
        {
            return await callback().ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            Fail(activity, exception);
            throw;
        }
    }

    /// <inheritdoc cref="StartSpanAsync{T}(string, Func{Task{T}})"/>
    public static Task StartSpanAsync(string name, Func<Task> callback) =>
        StartSpanAsync<object?>(name, async () =>
        {
            await callback().ConfigureAwait(false);
            return null;
        });

    /// <summary>Sends what is queued. Returns false if <paramref name="timeout"/> passes first or an export fails.</summary>
    public static bool Flush(TimeSpan timeout) => active?.Telemetry.Flush(timeout) ?? true;

    /// <summary>Sends what is queued, waiting up to two seconds.</summary>
    public static bool Flush() => Flush(DefaultTimeout);

    private static bool Close(Session session, TimeSpan timeout)
    {
        lock (InitGate)
        {
            if (!ReferenceEquals(active, session)) return true;
            active = null;
            AppDomain.CurrentDomain.FirstChanceException -= OnFirstChanceException;
            AppDomain.CurrentDomain.UnhandledException -= OnUnhandledException;
            TaskScheduler.UnobservedTaskException -= OnUnobservedTaskException;
            AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
            session.AspNetCore?.Dispose();
            return session.Telemetry.Shutdown(timeout);
        }
    }

    /// <summary>Flushes and shuts the SDK down. Init can be called again after it.</summary>
    public static bool Close(TimeSpan timeout)
    {
        var session = active;
        return session is null || Close(session, timeout);
    }

    /// <summary>Flushes and shuts the SDK down, waiting up to two seconds.</summary>
    public static bool Close() => Close(DefaultTimeout);
}
