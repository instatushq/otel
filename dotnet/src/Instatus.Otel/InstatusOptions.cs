using System;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace Instatus;

/// <summary>Options for <see cref="InstatusSdk.Init(Action{InstatusOptions})"/>. Every one is optional.</summary>
public sealed class InstatusOptions
{
    /// <summary>A secret API key. Falls back to <c>INSTATUS_API_KEY</c>.</summary>
    public string? ApiKey { get; set; }

    /// <summary>The site the telemetry belongs to. Falls back to <c>INSTATUS_SITE_ID</c>.</summary>
    public string? SiteId { get; set; }

    /// <summary>Replaces <c>https://otel.instatus.com</c>; <c>/v1/&lt;signal&gt;</c> is appended.</summary>
    public string? Endpoint { get; set; }

    /// <summary><c>service.name</c>. Falls back to <c>OTEL_SERVICE_NAME</c>, then the entry assembly's name.</summary>
    public string? ServiceName { get; set; }

    /// <summary><c>service.version</c>.</summary>
    public string? Release { get; set; }

    /// <summary><c>deployment.environment.name</c>.</summary>
    public string? Environment { get; set; }

    /// <summary>The share of root traces kept, from 0 to 1.</summary>
    public double TracesSampleRate { get; set; } = 1;

    /// <summary>Changes an event, or returns <c>null</c> to drop it. Runs before the filters.</summary>
    public Func<InstatusEvent, InstatusEvent?>? BeforeSend { get; set; }

    /// <summary>The most errors sent in a minute.</summary>
    public int MaxEventsPerMinute { get; set; } = 300;

    /// <summary>False keeps the SDK quiet, for tests and local development. Spans still work.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Prints why events are dropped to stderr.</summary>
    public bool Debug { get; set; }

    /// <summary>How long flushing waits at exit and when the handle from Init is disposed.</summary>
    public TimeSpan ShutdownTimeout { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>Adds instrumentation and sources to the tracer provider, such as <c>AddAspNetCoreInstrumentation()</c>.</summary>
    public Action<TracerProviderBuilder>? ConfigureTracing { get; set; }

    /// <summary>Adds instrumentation and meters to the meter provider, such as <c>AddRuntimeInstrumentation()</c>.</summary>
    public Action<MeterProviderBuilder>? ConfigureMetrics { get; set; }
}
