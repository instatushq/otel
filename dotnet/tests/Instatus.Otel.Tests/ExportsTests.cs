using System;
using System.Collections.Generic;
using System.Reflection;
using Instatus.Internal;
using Xunit;

namespace Instatus.Otel.Tests;

public class ExportsTests
{
    private static Func<string, string?> Env(params (string Key, string Value)[] values)
    {
        var map = new Dictionary<string, string>();
        foreach (var (key, value) in values) map[key] = value;
        return key => map.GetValueOrDefault(key);
    }

    [Fact]
    public void ApiKeySendsEverySignalToTheCollector()
    {
        var exports = Exports.Resolve(new InstatusOptions { ApiKey = "sk_test", SiteId = "site_1" }, Env());

        Assert.Equal(new Uri("https://otel.instatus.com/v1/logs"), exports[Signal.Logs].Url);
        Assert.Equal(new Uri("https://otel.instatus.com/v1/traces"), exports[Signal.Traces].Url);
        Assert.Equal(new Uri("https://otel.instatus.com/v1/metrics"), exports[Signal.Metrics].Url);
        foreach (var target in exports.Values)
        {
            Assert.Equal("Bearer sk_test", target.Headers["Authorization"]);
            Assert.Equal("site_1", target.Headers["X-Instatus-Site-Id"]);
            Assert.Equal("Authorization=Bearer sk_test,X-Instatus-Site-Id=site_1", target.HeaderString);
        }
    }

    [Fact]
    public void KeyAndSiteFallBackToTheEnvironment()
    {
        var exports = Exports.Resolve(new InstatusOptions(), Env(("INSTATUS_API_KEY", "sk_env"), ("INSTATUS_SITE_ID", "site_env")));

        Assert.Equal("Bearer sk_env", exports[Signal.Logs].Headers["Authorization"]);
        Assert.Equal("site_env", exports[Signal.Logs].Headers["X-Instatus-Site-Id"]);
    }

    [Fact]
    public void OptionsWinOverTheEnvironment()
    {
        var exports = Exports.Resolve(new InstatusOptions { ApiKey = "sk_option" }, Env(("INSTATUS_API_KEY", "sk_env")));

        Assert.Equal("Bearer sk_option", exports[Signal.Traces].Headers["Authorization"]);
    }

    [Fact]
    public void SiteHeaderNeedsASiteId()
    {
        var exports = Exports.Resolve(new InstatusOptions { ApiKey = "sk_test" }, Env());

        Assert.False(exports[Signal.Logs].Headers.ContainsKey("X-Instatus-Site-Id"));
    }

    [Theory]
    [InlineData("http://localhost:4318")]
    [InlineData("http://localhost:4318/")]
    public void EndpointReplacesTheHost(string endpoint)
    {
        var withKey = Exports.Resolve(new InstatusOptions { ApiKey = "sk_test", Endpoint = endpoint }, Env());
        var withoutKey = Exports.Resolve(new InstatusOptions { Endpoint = endpoint }, Env());

        Assert.Equal(new Uri("http://localhost:4318/v1/logs"), withKey[Signal.Logs].Url);
        Assert.Equal(new Uri("http://localhost:4318/v1/traces"), withoutKey[Signal.Traces].Url);
        Assert.Empty(withoutKey[Signal.Metrics].Headers);
    }

    [Fact]
    public void StandardOtlpVariablesApplyWithoutAnEndpoint()
    {
        var generic = Exports.Resolve(new InstatusOptions(), Env(("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")));
        var tracesOnly = Exports.Resolve(new InstatusOptions(), Env(("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://collector:4318/v1/traces")));
        var keyAndEnv = Exports.Resolve(new InstatusOptions { ApiKey = "sk_test" }, Env(("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")));

        Assert.Equal(3, generic.Count);
        Assert.All(generic.Values, target => Assert.Null(target.Url));
        Assert.Equal(new[] { Signal.Traces }, tracesOnly.Keys);
        Assert.Null(keyAndEnv[Signal.Logs].Url);
        Assert.Equal("Bearer sk_test", keyAndEnv[Signal.Logs].Headers["Authorization"]);
    }

    [Fact]
    public void NothingExportsWithoutAKeyOrEndpoint() => Assert.Empty(Exports.Resolve(new InstatusOptions(), Env()));

    [Fact]
    public void ResourceAttributesFromOptions()
    {
        var attributes = ServiceResource.FromOptions(new InstatusOptions
        {
            ServiceName = "checkout",
            Release = "checkout@1.0.0",
            Environment = "production"
        });

        Assert.Equal("checkout", attributes["service.name"]);
        Assert.Equal("checkout@1.0.0", attributes["service.version"]);
        Assert.Equal("production", attributes["deployment.environment.name"]);
        Assert.Equal("Instatus.Otel", attributes["telemetry.sdk.name"]);
        Assert.Equal(InstatusSdk.Version, attributes["telemetry.sdk.version"]);
        Assert.Equal("dotnet", attributes["telemetry.sdk.language"]);
    }

    [Fact]
    public void DetectedResourceHasHostAndProcess()
    {
        var attributes = ServiceResource.Detected();

        Assert.Equal(Environment.MachineName, attributes["host.name"]);
        Assert.Equal((long)Environment.ProcessId, attributes["process.pid"]);
        Assert.Equal(".NET", attributes["process.runtime.name"]);
        Assert.False(attributes.ContainsKey("process.command_args"));
    }

    [Fact]
    public void VersionMatchesThePackage()
    {
        var informational = typeof(InstatusSdk).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion;

        Assert.Equal(InstatusSdk.Version, informational.Split('+')[0]);
    }
}
