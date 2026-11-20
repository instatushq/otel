using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Instatus.Internal;
using Xunit;

namespace Instatus.Otel.Tests;

internal sealed class RecordingSink : IErrorSink
{
    public List<ErrorLogRecord> Records { get; } = new();

    public void Emit(ErrorLogRecord record) => Records.Add(record);
}

public class ClientTests
{
    private static (Client Client, RecordingSink Sink) Create(InstatusOptions? options = null, RateCap? rateCap = null)
    {
        var sink = new RecordingSink();
        return (new Client(options ?? new InstatusOptions(), sink, rateCap ?? new RateCap(300, TimeSpan.FromMinutes(1))), sink);
    }

    private static InstatusEvent ErrorEvent(string message) =>
        InstatusSdk.EventFromException(new InvalidOperationException(message), true, SeverityLevel.Error);

    [Fact]
    public void IdenticalErrorsInARowAreSentOnce()
    {
        var (client, sink) = Create();

        client.Capture(ErrorEvent("boom"));
        client.Capture(ErrorEvent("boom"));
        client.Capture(ErrorEvent("other"));
        client.Capture(ErrorEvent("boom"));

        Assert.Equal(new[] { "boom", "other", "boom" }, sink.Records.Select(record => record.Attribute("exception.message")));
    }

    [Fact]
    public void AnExceptionIsCapturedOnce()
    {
        var (client, sink) = Create();
        var exception = new InvalidOperationException("boom");

        client.Capture(InstatusSdk.EventFromException(exception, true, SeverityLevel.Error));
        client.Capture(ErrorEvent("between"));
        client.Capture(InstatusSdk.EventFromException(exception, false, SeverityLevel.Fatal));

        Assert.Equal(2, sink.Records.Count);
    }

    [Fact]
    public void RateCapResetsEachWindow()
    {
        var now = DateTimeOffset.UnixEpoch;
        var cap = new RateCap(2, TimeSpan.FromMinutes(1), () => now);

        Assert.True(cap.Take());
        Assert.True(cap.Take());
        Assert.False(cap.Take());
        now = now.AddSeconds(59);
        Assert.False(cap.Take());
        now = now.AddSeconds(1);
        Assert.True(cap.Take());
    }

    [Fact]
    public void PipelineStopsAtTheRateCap()
    {
        var (client, sink) = Create(rateCap: new RateCap(3, TimeSpan.FromMinutes(1)));

        for (var index = 0; index < 10; index++) client.Capture(ErrorEvent($"error {index}"));

        Assert.Equal(3, sink.Records.Count);
    }

    [Fact]
    public void BeforeSendChangesOrDropsEvents()
    {
        var (client, sink) = Create(new InstatusOptions
        {
            BeforeSend = source =>
            {
                if (source.Exception?.Value == "drop me") return null;
                source.Tags["checked"] = "yes";
                return source;
            }
        });

        var dropped = ErrorEvent("drop me");
        var droppedId = client.Capture(dropped);
        client.Capture(ErrorEvent("keep me"));

        Assert.Equal(dropped.EventId, droppedId);
        var record = Assert.Single(sink.Records);
        Assert.Equal("keep me", record.Attribute("exception.message"));
        Assert.Equal("yes", record.Attribute("checked"));
    }

    [Fact]
    public void BeforeSendRunsBeforeTheFilters()
    {
        string? seen = null;
        var (client, sink) = Create(new InstatusOptions
        {
            BeforeSend = source =>
            {
                seen = source.Exception?.Value;
                return source;
            }
        });

        client.Capture(ErrorEvent("card 4111 1111 1111 1111"));

        Assert.Equal("card 4111 1111 1111 1111", seen);
        Assert.Equal("card [Filtered]", Assert.Single(sink.Records).Attribute("exception.message"));
    }

    [Fact]
    public void ThrowingBeforeSendDropsTheEvent()
    {
        var (client, sink) = Create(new InstatusOptions { BeforeSend = _ => throw new InvalidOperationException("bug") });

        client.Capture(ErrorEvent("boom"));

        Assert.Empty(sink.Records);
    }

    [Fact]
    public void DisabledClientSendsNothing()
    {
        var (client, sink) = Create(new InstatusOptions { Enabled = false });

        client.Capture(ErrorEvent("boom"));

        Assert.Empty(sink.Records);
    }

    [Fact]
    public void ErrorsGoOnTheActiveSpan()
    {
        using var source = new ActivitySource("Instatus.Otel.Tests.Client");
        using var listener = new ActivityListener
        {
            ShouldListenTo = candidate => candidate.Name == source.Name,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded
        };
        ActivitySource.AddActivityListener(listener);
        var (client, _) = Create();

        using var activity = source.StartActivity("charge")!;
        client.Capture(ErrorEvent("card 4111 1111 1111 1111 declined"));

        var exceptionEvent = Assert.Single(activity.Events);
        Assert.Equal("exception", exceptionEvent.Name);
        var tags = exceptionEvent.Tags.ToDictionary(tag => tag.Key, tag => tag.Value);
        Assert.Equal("System.InvalidOperationException", tags["exception.type"]);
        Assert.Equal("card [Filtered] declined", tags["exception.message"]);
        Assert.DoesNotContain("4111", (string)tags["exception.stacktrace"]!);
        Assert.Equal(ActivityStatusCode.Unset, activity.Status);
    }

    [Fact]
    public void MessagesDoNotGoOnTheSpan()
    {
        using var source = new ActivitySource("Instatus.Otel.Tests.Messages");
        using var listener = new ActivityListener
        {
            ShouldListenTo = candidate => candidate.Name == source.Name,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded
        };
        ActivitySource.AddActivityListener(listener);
        var (client, sink) = Create();

        using var activity = source.StartActivity("work")!;
        client.Capture(new InstatusEvent { Level = SeverityLevel.Error, Message = "boom" });

        Assert.Empty(activity.Events);
        Assert.Single(sink.Records);
    }
}
