using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;

namespace Instatus.Internal;

// ASP.NET Core catches what requests throw, so AppDomain never sees it; its
// diagnostic events, read by name to avoid an ASP.NET Core dependency, do.
internal sealed class AspNetCoreErrors : IObserver<DiagnosticListener>, IObserver<KeyValuePair<string, object?>>, IDisposable
{
    private const string ListenerName = "Microsoft.AspNetCore";
    private const string BeginRequest = "Microsoft.AspNetCore.Hosting.BeginRequest";
    private const string HostingUnhandled = "Microsoft.AspNetCore.Hosting.UnhandledException";
    private const string DiagnosticsUnhandled = "Microsoft.AspNetCore.Diagnostics.UnhandledException";

    private static readonly ConcurrentDictionary<(Type, string), PropertyInfo?> Properties = new();

    private readonly List<IDisposable> subscriptions = new();
    private readonly object gate = new();
    private bool disposed;

    public static AspNetCoreErrors Start()
    {
        var errors = new AspNetCoreErrors();
        var subscription = DiagnosticListener.AllListeners.Subscribe(errors);
        lock (errors.gate) errors.subscriptions.Add(subscription);
        return errors;
    }

    private static bool IsObserved(string name) =>
        name is BeginRequest or HostingUnhandled or DiagnosticsUnhandled;

    public void OnNext(DiagnosticListener listener)
    {
        if (listener.Name != ListenerName) return;
        lock (gate)
        {
            if (disposed) return;
            subscriptions.Add(listener.Subscribe(this, IsObserved));
        }
    }

    public void OnNext(KeyValuePair<string, object?> diagnostic)
    {
        try
        {
            Handle(diagnostic.Key, diagnostic.Value);
        }
        catch (Exception)
        {
            return;
        }
    }

    private static void Handle(string name, object? payload)
    {
        if (payload is null) return;
        if (name == BeginRequest)
        {
            Scopes.PushRequest(RequestUrlOf(Read(payload, "httpContext")));
            return;
        }
        if (Read(payload, "exception") is Exception exception)
            InstatusSdk.CaptureUnhandled(exception, SeverityLevel.Error);
    }

    private static object? Read(object? owner, string name)
    {
        if (owner is null) return null;
        var property = Properties.GetOrAdd((owner.GetType(), name), key =>
            key.Item1.GetProperty(key.Item2, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase));
        return property?.GetValue(owner);
    }

    private static string? RequestUrlOf(object? httpContext)
    {
        var request = Read(httpContext, "Request");
        if (request is null) return null;
        var scheme = Read(request, "Scheme");
        var host = Read(request, "Host");
        var pathBase = Read(request, "PathBase");
        var path = Read(request, "Path");
        var query = Read(request, "QueryString");
        return $"{scheme}://{host}{pathBase}{path}{query}";
    }

    public void OnCompleted()
    {
    }

    public void OnError(Exception error)
    {
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            foreach (var subscription in subscriptions) subscription.Dispose();
            subscriptions.Clear();
        }
    }
}
