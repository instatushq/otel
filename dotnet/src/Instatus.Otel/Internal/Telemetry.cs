using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Instatus.Internal;

internal sealed class ErrorState : IReadOnlyList<KeyValuePair<string, object?>>
{
    private readonly ErrorLogRecord record;

    public ErrorState(ErrorLogRecord record) => this.record = record;

    public static string Format(ErrorState state, Exception? _) => state.record.Body;

    public KeyValuePair<string, object?> this[int index] => record.Attributes[index];

    public int Count => record.Attributes.Count;

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => record.Attributes.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

// OpenTelemetry .NET writes log records only through ILogger, so errors go
// through a logger of the SDK's own factory.
internal sealed class Telemetry : IErrorSink
{
    public static readonly ActivitySource Source = new(InstatusSdk.Name, InstatusSdk.Version);

    private readonly OpenTelemetrySdk sdk;
    private readonly ILogger errorLogger;

    private Telemetry(OpenTelemetrySdk sdk)
    {
        this.sdk = sdk;
        LoggerFactory = sdk.GetLoggerFactory();
        errorLogger = LoggerFactory.CreateLogger(InstatusSdk.Name);
    }

    public ILoggerFactory LoggerFactory { get; }

    public void Emit(ErrorLogRecord record) =>
        errorLogger.Log(record.LogLevel, default, new ErrorState(record), null, ErrorState.Format);

    private static bool HasEnv(Func<string, string?> getenv, string name) => !string.IsNullOrEmpty(getenv(name));

    // The OTLP exporter defaults to gRPC in .NET; the collector and the spec
    // default are HTTP/protobuf, so that is used unless the app picked one.
    private static void ConfigureExporter(OtlpExporterOptions exporter, SignalExport target, Signal signal, Func<string, string?> getenv)
    {
        if (target.Url is not null) exporter.Endpoint = target.Url;
        if (target.Headers.Count > 0) exporter.Headers = target.HeaderString;
        var signalProtocol = $"OTEL_EXPORTER_OTLP_{signal.ToString().ToUpperInvariant()}_PROTOCOL";
        var protocolChosen = HasEnv(getenv, "OTEL_EXPORTER_OTLP_PROTOCOL") || HasEnv(getenv, signalProtocol);
        if (target.Url is not null || !protocolChosen) exporter.Protocol = OtlpExportProtocol.HttpProtobuf;
    }

    private static void ConfigureResource(ResourceBuilder resource, InstatusOptions options)
    {
        var defaults = ServiceResource.Detected();
        defaults["service.name"] = ServiceResource.DefaultServiceName();
        resource.Clear()
            .AddAttributes(defaults)
            .AddEnvironmentVariableDetector()
            .AddAttributes(ServiceResource.FromOptions(options));
    }

    // Disabled, the providers still exist so spans and context work, but
    // nothing is exported and no instrumentation is added.
    public static Telemetry Create(InstatusOptions options, IReadOnlyDictionary<Signal, SignalExport> exports, Func<string, string?> getenv)
    {
        Sdk.SetDefaultTextMapPropagator(new CompositeTextMapPropagator(new TextMapPropagator[]
        {
            new TraceContextPropagator(),
            new BaggagePropagator()
        }));
        var sampleRate = Math.Clamp(options.TracesSampleRate, 0, 1);
        var sdk = OpenTelemetrySdk.Create(builder =>
        {
            builder.Services.Configure<LoggerFilterOptions>(filter => filter.MinLevel = LogLevel.Trace);
            builder.ConfigureResource(resource => ConfigureResource(resource, options));
            builder.WithTracing(tracing =>
            {
                tracing.AddSource(InstatusSdk.Name);
                tracing.SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(sampleRate)));
                if (options.Enabled) options.ConfigureTracing?.Invoke(tracing);
                if (exports.TryGetValue(Signal.Traces, out var target))
                    tracing.AddOtlpExporter(exporter => ConfigureExporter(exporter, target, Signal.Traces, getenv));
            });
            builder.WithMetrics(metrics =>
            {
                if (options.Enabled) options.ConfigureMetrics?.Invoke(metrics);
                if (exports.TryGetValue(Signal.Metrics, out var target))
                    metrics.AddOtlpExporter(exporter => ConfigureExporter(exporter, target, Signal.Metrics, getenv));
            });
            builder.WithLogging(
                logging =>
                {
                    if (exports.TryGetValue(Signal.Logs, out var target))
                        logging.AddOtlpExporter(exporter => ConfigureExporter(exporter, target, Signal.Logs, getenv));
                },
                logging =>
                {
                    logging.IncludeFormattedMessage = true;
                    logging.IncludeScopes = false;
                });
        });
        return new Telemetry(sdk);
    }

    private static int RemainingMilliseconds(Stopwatch clock, TimeSpan timeout) =>
        (int)Math.Max(0, Math.Min(int.MaxValue, (timeout - clock.Elapsed).TotalMilliseconds));

    public bool Flush(TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        var traces = sdk.TracerProvider.ForceFlush(RemainingMilliseconds(clock, timeout));
        var logs = sdk.LoggerProvider.ForceFlush(RemainingMilliseconds(clock, timeout));
        var metrics = sdk.MeterProvider.ForceFlush(RemainingMilliseconds(clock, timeout));
        return traces && logs && metrics;
    }

    public bool Shutdown(TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        var traces = sdk.TracerProvider.Shutdown(RemainingMilliseconds(clock, timeout));
        var logs = sdk.LoggerProvider.Shutdown(RemainingMilliseconds(clock, timeout));
        var metrics = sdk.MeterProvider.Shutdown(RemainingMilliseconds(clock, timeout));
        sdk.Dispose();
        return traces && logs && metrics;
    }
}
