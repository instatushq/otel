using System;
using System.Diagnostics;

namespace Instatus.Internal;

internal interface IErrorSink
{
    void Emit(ErrorLogRecord record);
}

internal sealed class Client
{
    private static readonly string[] SpanEventKeys = { "exception.type", "exception.message", "exception.stacktrace" };

    private readonly Func<InstatusEvent, InstatusEvent?>? beforeSend;
    private readonly IErrorSink sink;
    private readonly RateCap rateCap;
    private readonly Dedupe dedupe = new();
    private readonly bool enabled;
    private readonly bool debug;

    public Client(InstatusOptions options, IErrorSink sink, RateCap rateCap)
    {
        beforeSend = options.BeforeSend;
        enabled = options.Enabled;
        debug = options.Debug;
        this.sink = sink;
        this.rateCap = rateCap;
    }

    public void Log(string message)
    {
        if (debug) Console.Error.WriteLine($"[instatus] {message}");
    }

    // Reporting must never throw into an app that is already handling an error.
    public string Capture(InstatusEvent source)
    {
        try
        {
            return Send(source);
        }
        catch (Exception exception)
        {
            Log($"could not send an event: {exception.Message}");
            return source.EventId;
        }
    }

    private string Send(InstatusEvent source)
    {
        if (!enabled) return source.EventId;
        if (CapturedExceptions.WasCaptured(source.OriginalException))
        {
            Log("dropped an event: already captured");
            return source.EventId;
        }
        CapturedExceptions.MarkCaptured(source.OriginalException);
        var kept = RunBeforeSend(source);
        if (kept is null)
        {
            Log("BeforeSend dropped an event");
            return source.EventId;
        }
        if (dedupe.IsDuplicate(kept))
        {
            Log("dropped a duplicate event");
            return kept.EventId;
        }
        if (!rateCap.Take())
        {
            Log("rate cap reached");
            return kept.EventId;
        }
        var record = RecordMapper.ToRecord(kept);
        RecordOnActivity(Activity.Current, kept, record);
        sink.Emit(record);
        return kept.EventId;
    }

    private InstatusEvent? RunBeforeSend(InstatusEvent source)
    {
        if (beforeSend is null) return source;
        try
        {
            return beforeSend(source);
        }
        catch (Exception exception)
        {
            Log($"BeforeSend threw: {exception.Message}");
            return null;
        }
    }

    // The span event is what OpenTelemetry's own AddException writes. It is
    // built from the filtered record, so traces carry nothing the log doesn't.
    private static void RecordOnActivity(Activity? activity, InstatusEvent source, ErrorLogRecord record)
    {
        if (source.Exception is null || activity is null || !activity.IsAllDataRequested) return;
        var tags = new TagList();
        foreach (var key in SpanEventKeys)
        {
            if (record.Attribute(key) is string value) tags.Add(key, value);
        }
        if (source.OriginalException is not null && tags.Count == SpanEventKeys.Length)
            activity.AddException(source.OriginalException, tags, source.Timestamp);
        else
            activity.AddEvent(new ActivityEvent("exception", source.Timestamp, new ActivityTagsCollection(tags)));
        if (!source.Exception.Handled)
            activity.SetStatus(ActivityStatusCode.Error, record.Attribute("exception.message") as string);
    }
}
