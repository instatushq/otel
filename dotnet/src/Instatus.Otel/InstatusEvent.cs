using System;
using System.Collections.Generic;

namespace Instatus;

/// <summary>The exception an event reports.</summary>
public sealed class ExceptionInfo
{
    /// <summary>The exception's type as .NET prints it, such as <c>System.InvalidOperationException</c>.</summary>
    public string Type { get; set; } = "";

    /// <summary>The exception's message.</summary>
    public string Value { get; set; } = "";

    /// <summary><see cref="Exception.ToString"/>: the type, message, inner exceptions and stack, as .NET prints them.</summary>
    public string? Stacktrace { get; set; }

    /// <summary>False when the app did not catch the exception.</summary>
    public bool Handled { get; set; } = true;
}

/// <summary>What <see cref="InstatusOptions.BeforeSend"/> receives, before the filters run.</summary>
public sealed class InstatusEvent
{
    /// <summary>32 hex characters, sent as <c>log.record.uid</c>.</summary>
    public string EventId { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>When the event happened.</summary>
    public DateTimeOffset Timestamp { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>The event's severity.</summary>
    public SeverityLevel Level { get; set; } = SeverityLevel.Error;

    /// <summary>The message of an event from <see cref="InstatusSdk.CaptureMessage"/>.</summary>
    public string? Message { get; set; }

    /// <summary>The exception of an event from <see cref="InstatusSdk.CaptureException(Exception)"/>.</summary>
    public ExceptionInfo? Exception { get; set; }

    /// <summary>The exception that was captured, if any.</summary>
    public Exception? OriginalException { get; init; }

    /// <summary>The URL of the request the event happened in, sent as <c>url.full</c> and <c>url.path</c>.</summary>
    public string? RequestUrl { get; set; }

    /// <summary>Who the event affected.</summary>
    public InstatusUser? User { get; set; }

    /// <summary>Sent as attributes under their own keys.</summary>
    public IDictionary<string, string> Tags { get; set; } = new Dictionary<string, string>();

    /// <summary>Sent as <c>&lt;name&gt;.&lt;key&gt;</c> attributes.</summary>
    public IDictionary<string, object?> Contexts { get; set; } = new Dictionary<string, object?>();

    /// <summary>Sent as <c>extra.&lt;key&gt;</c> attributes.</summary>
    public IDictionary<string, object?> Extra { get; set; } = new Dictionary<string, object?>();
}
