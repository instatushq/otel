using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Instatus.Internal;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Instatus.Otel.Tests;

[Collection(SdkCollection.Name)]
public sealed class EndToEndTests : IDisposable
{
    private readonly Collector collector = new();

    public EndToEndTests() => Scopes.Reset();

    public void Dispose()
    {
        InstatusSdk.Close();
        Scopes.Reset();
        collector.Dispose();
    }

    private IDisposable Init(Action<InstatusOptions>? configure = null) =>
        InstatusSdk.Init(options =>
        {
            options.ApiKey = "sk_test";
            options.SiteId = "site_1";
            options.Endpoint = collector.Endpoint;
            options.ServiceName = "checkout";
            options.Release = "checkout@1.0.0";
            options.Environment = "test";
            configure?.Invoke(options);
        });

    private static string Hex(byte[]? bytes) => bytes is null ? "" : Convert.ToHexString(bytes).ToLowerInvariant();

    private static Dictionary<string, object?> AttributesOf(ProtoMessage record) => Otlp.Attributes(record, 6);

    private static string BodyOf(ProtoMessage record) => Otlp.ValueOf(record.Message(5)) as string ?? "";

    private static void Charge() => throw new InvalidOperationException("card 4111 1111 1111 1111 declined");

    [Fact]
    public void InitExportsErrorsLogsAndTraces()
    {
        using var handle = Init();
        using var loggerFactory = LoggerFactory.Create(logging => logging.AddInstatus());
        var logger = loggerFactory.CreateLogger("Checkout");

        InstatusSdk.SetUser(new InstatusUser { Id = "42", Email = "ada@example.com" });
        InstatusSdk.SetTag("plan", "pro");
        string? traceId = null;
        string? spanId = null;
        var eventId = InstatusSdk.StartSpan("charge", () =>
        {
            traceId = System.Diagnostics.Activity.Current?.TraceId.ToHexString();
            spanId = System.Diagnostics.Activity.Current?.SpanId.ToHexString();
            try
            {
                Charge();
                return "";
            }
            catch (Exception exception)
            {
                return InstatusSdk.CaptureException(exception, scope => scope.SetTag("step", "charge"));
            }
        });
        InstatusSdk.CaptureMessage("Stripe webhook signature mismatch", SeverityLevel.Error);
        logger.LogInformation("order placed with {Items} items", 3);
        logger.LogInformation("login {Password} card {Card}", "hunter2", "4111 1111 1111 1111");
        logger.LogError(new TimeoutException("gateway"), "payment failed for order {Order}", "A1");
        Assert.True(InstatusSdk.Flush(TimeSpan.FromSeconds(10)));

        foreach (var path in new[] { "/v1/logs", "/v1/traces" })
        {
            var received = collector.On(path);
            Assert.NotEmpty(received);
            Assert.All(received, request =>
            {
                Assert.Equal("Bearer sk_test", request.Headers["Authorization"]);
                Assert.Equal("site_1", request.Headers["X-Instatus-Site-Id"]);
                Assert.Equal("application/x-protobuf", request.Headers["Content-Type"]);
            });
        }

        var records = collector.LogRecords();
        var (resource, scopeName, error) = Assert.Single(records, entry => BodyOf(entry.Record).StartsWith("System.InvalidOperationException"));
        Assert.Equal("checkout", resource["service.name"]);
        Assert.Equal("checkout@1.0.0", resource["service.version"]);
        Assert.Equal("test", resource["deployment.environment.name"]);
        Assert.Equal("Instatus.Otel", resource["telemetry.sdk.name"]);
        Assert.Equal(InstatusSdk.Version, resource["telemetry.sdk.version"]);
        Assert.Equal("dotnet", resource["telemetry.sdk.language"]);
        Assert.Equal(Environment.MachineName, resource["host.name"]);
        Assert.Equal("Instatus.Otel", scopeName);

        Assert.Equal("System.InvalidOperationException: card [Filtered] declined", BodyOf(error));
        Assert.Equal(17UL, error.Varint(2));
        var attributes = AttributesOf(error);
        Assert.Equal("System.InvalidOperationException", attributes["exception.type"]);
        Assert.Equal("card [Filtered] declined", attributes["exception.message"]);
        Assert.Equal(true, attributes["exception.handled"]);
        Assert.Equal(eventId, attributes["log.record.uid"]);
        Assert.Matches("^[0-9a-f]{32}$", eventId);
        Assert.Equal("42", attributes["enduser.id"]);
        Assert.Equal("pro", attributes["plan"]);
        Assert.Equal("charge", attributes["step"]);
        var stack = Assert.IsType<string>(attributes["exception.stacktrace"]);
        Assert.Contains("   at Instatus.Otel.Tests.EndToEndTests.Charge() in ", stack);
        Assert.Matches(@"EndToEndTests\.cs:line \d+", stack);
        Assert.DoesNotContain("4111", stack);
        Assert.Equal("dotnet", StackFormat.Detect(stack));
        Assert.Equal(traceId, Hex(error.Bytes(9)));
        Assert.Equal(spanId, Hex(error.Bytes(10)));

        var message = Assert.Single(records, entry => BodyOf(entry.Record) == "Stripe webhook signature mismatch").Record;
        Assert.Equal("Error", AttributesOf(message)["exception.type"]);

        var log = Assert.Single(records, entry => BodyOf(entry.Record) == "order placed with 3 items");
        Assert.Equal("Checkout", log.Scope);
        Assert.Equal(9UL, log.Record.Varint(2));
        Assert.Equal(3L, AttributesOf(log.Record)["Items"]);

        var login = Assert.Single(records, entry => BodyOf(entry.Record) == "login [Filtered] card [Filtered]").Record;
        var loginAttributes = AttributesOf(login);
        Assert.Equal("[Filtered]", loginAttributes["Password"]);
        Assert.Equal("[Filtered]", loginAttributes["Card"]);
        Assert.All(loginAttributes.Values, value => Assert.DoesNotContain("hunter2", value as string ?? ""));
        Assert.All(loginAttributes.Values, value => Assert.DoesNotContain("4111", value as string ?? ""));

        var failedLog = Assert.Single(records, entry => BodyOf(entry.Record) == "payment failed for order A1").Record;
        Assert.False(AttributesOf(failedLog).ContainsKey("exception.type"));
        var loggedError = Assert.Single(records, entry => BodyOf(entry.Record) == "System.TimeoutException: gateway").Record;
        Assert.Equal("42", AttributesOf(loggedError)["enduser.id"]);

        var span = Assert.Single(collector.Spans(), candidate => candidate.String(5) == "charge");
        Assert.Equal(traceId, Hex(span.Bytes(1)));
        var spanEvent = Assert.Single(span.Messages(11));
        Assert.Equal("exception", spanEvent.String(2));
        var eventAttributes = Otlp.Attributes(spanEvent, 3);
        Assert.Equal("System.InvalidOperationException", eventAttributes["exception.type"]);
        Assert.Equal("card [Filtered] declined", eventAttributes["exception.message"]);
        Assert.DoesNotContain("4111", (string)eventAttributes["exception.stacktrace"]!);
        Assert.Null(span.Message(15)?.Varint(3));
    }

    [Fact]
    public void UncaughtErrorsAreFatalAndUnhandled()
    {
        using var handle = Init();

        try
        {
            Charge();
        }
        catch (Exception exception)
        {
            InstatusSdk.CaptureUnhandled(exception, SeverityLevel.Fatal);
        }
        Assert.True(InstatusSdk.Flush(TimeSpan.FromSeconds(10)));

        var record = Assert.Single(collector.LogRecords()).Record;
        Assert.Equal(21UL, record.Varint(2));
        Assert.Equal(false, AttributesOf(record)["exception.handled"]);
    }

    [Fact]
    public void DisabledSendsNothingButSpansStillRun()
    {
        using var handle = Init(options => options.Enabled = false);

        var ran = InstatusSdk.StartSpan("work", () => System.Diagnostics.Activity.Current is not null);
        InstatusSdk.CaptureException(new InvalidOperationException("boom"));
        InstatusSdk.Flush(TimeSpan.FromSeconds(2));

        Assert.True(ran);
        Assert.Empty(collector.On("/v1/logs"));
        Assert.Empty(collector.On("/v1/traces"));
    }

    [Fact]
    public void CaptureBeforeInitIsANoop()
    {
        Assert.False(InstatusSdk.IsEnabled);
        Assert.Equal("", InstatusSdk.CaptureException(new InvalidOperationException("boom")));
        Assert.True(InstatusSdk.Flush());
        Assert.True(InstatusSdk.Close());
    }

    [Fact]
    public async Task StartSpanAsyncMarksAFailedSpan()
    {
        using var handle = Init();

        await Assert.ThrowsAsync<TimeoutException>(() => InstatusSdk.StartSpanAsync("call-gateway", async () =>
        {
            await Task.Yield();
            throw new TimeoutException("gateway 4111 1111 1111 1111");
        }));
        Assert.True(InstatusSdk.Flush(TimeSpan.FromSeconds(10)));

        var span = Assert.Single(collector.Spans(), candidate => candidate.String(5) == "call-gateway");
        Assert.Equal(2UL, span.Message(15)?.Varint(3));
        Assert.Equal("gateway [Filtered]", span.Message(15)?.String(2));
    }

    [Theory]
    [InlineData(true, "Production")]
    [InlineData(false, "Production")]
    [InlineData(false, "Development")]
    public async Task AspNetCoreRequestsGetTheirOwnScopeAndReportUnhandledErrors(bool withLogging, string environment)
    {
        using var handle = Init();
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        if (withLogging) builder.Logging.AddInstatus();
        await using var app = builder.Build();
        app.MapGet("/orders/{id}", async (string id, HttpContext context) =>
        {
            await Task.Yield();
            var user = context.Request.Query["user"].ToString();
            if (user.Length > 0) InstatusSdk.SetUser(new InstatusUser { Id = user });
            throw new InvalidOperationException($"order {id} failed");
        });
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

        using var client = new HttpClient { BaseAddress = new Uri(address) };
        var first = await client.GetAsync("/orders/1?user=ada&token=secret");
        var second = await client.GetAsync("/orders/2");
        await app.StopAsync();
        Assert.True(InstatusSdk.Flush(TimeSpan.FromSeconds(10)));

        Assert.Equal(500, (int)first.StatusCode);
        Assert.Equal(500, (int)second.StatusCode);
        var errors = collector.LogRecords()
            .Select(entry => AttributesOf(entry.Record))
            .Where(attributes => attributes.TryGetValue("exception.type", out var type) && type as string == "System.InvalidOperationException")
            .ToList();
        var forFirst = Assert.Single(errors, attributes => (string)attributes["exception.message"]! == "order 1 failed");
        var forSecond = Assert.Single(errors, attributes => (string)attributes["exception.message"]! == "order 2 failed");
        Assert.Equal("ada", forFirst["enduser.id"]);
        Assert.Equal(false, forFirst["exception.handled"]);
        Assert.Equal($"{address}/orders/1?user=ada&token=[Filtered]", forFirst["url.full"]);
        Assert.Equal("/orders/1", forFirst["url.path"]);
        Assert.False(forSecond.ContainsKey("enduser.id"));
        Assert.Equal("/orders/2", forSecond["url.path"]);
        Assert.Equal("dotnet", StackFormat.Detect((string)forFirst["exception.stacktrace"]!));
    }
}
