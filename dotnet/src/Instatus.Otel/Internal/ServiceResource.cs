using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Instatus.Internal;

internal static class ServiceResource
{
    private const string Language = "dotnet";
    private const string FallbackServiceName = "dotnet";

    public static string DefaultServiceName() =>
        Assembly.GetEntryAssembly()?.GetName().Name ?? FallbackServiceName;

    // Command-line arguments are left out because they often carry secrets.
    public static Dictionary<string, object> Detected()
    {
        var attributes = new Dictionary<string, object>
        {
            ["host.name"] = Environment.MachineName,
            ["host.arch"] = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
            ["os.type"] = OsType(),
            ["os.description"] = RuntimeInformation.OSDescription,
            ["process.pid"] = (long)Environment.ProcessId,
            ["process.runtime.name"] = ".NET",
            ["process.runtime.version"] = Environment.Version.ToString(),
            ["process.runtime.description"] = RuntimeInformation.FrameworkDescription
        };
        var executable = ExecutableName();
        if (executable is not null) attributes["process.executable.name"] = executable;
        return attributes;
    }

    private static string OsType()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsMacOS()) return "darwin";
        if (OperatingSystem.IsLinux()) return "linux";
        if (OperatingSystem.IsFreeBSD()) return "freebsd";
        return RuntimeInformation.OSDescription;
    }

    private static string? ExecutableName()
    {
        try
        {
            using var process = Process.GetCurrentProcess();
            return process.ProcessName;
        }
        catch (Exception)
        {
            return null;
        }
    }

    // Sentry's release and environment are OpenTelemetry resource attributes.
    public static Dictionary<string, object> FromOptions(InstatusOptions options)
    {
        var attributes = new Dictionary<string, object>
        {
            ["telemetry.sdk.name"] = InstatusSdk.Name,
            ["telemetry.sdk.version"] = InstatusSdk.Version,
            ["telemetry.sdk.language"] = Language
        };
        if (!string.IsNullOrEmpty(options.ServiceName)) attributes["service.name"] = options.ServiceName;
        if (!string.IsNullOrEmpty(options.Release)) attributes["service.version"] = options.Release;
        if (!string.IsNullOrEmpty(options.Environment)) attributes["deployment.environment.name"] = options.Environment;
        return attributes;
    }
}
