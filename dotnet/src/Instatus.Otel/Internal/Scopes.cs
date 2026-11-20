using System;
using System.Runtime.CompilerServices;
using System.Threading;

namespace Instatus.Internal;

// A task a flow starts and a method it awaits run on the same
// ExecutionContext as the flow, so neither can be told apart from it: every
// change goes to a copy the changing flow alone sees. Shared is the scope a
// request or WithScope hands out, changed only through that object.
internal static class Scopes
{
    private sealed record Frame(Scope? Shared, Scope Local, Scope? RequestBase);

    private static readonly AsyncLocal<Frame?> CurrentFrame = new();
    private static readonly ConditionalWeakTable<Exception, Frame> Thrown = new();

    public static Scope Global { get; } = new();

    private static Scope Flatten(Frame? frame) => frame is null ? new Scope() : frame.Local.Over(frame.Shared);

    public static void Change(Action<Scope> change)
    {
        var current = CurrentFrame.Value;
        var local = current?.Local.Clone() ?? new Scope();
        change(local);
        CurrentFrame.Value = new Frame(current?.Shared, local, current?.RequestBase);
    }

    public static T With<T>(Func<Scope, T> callback)
    {
        var previous = CurrentFrame.Value;
        var scope = Flatten(previous);
        CurrentFrame.Value = new Frame(scope, new Scope(), previous?.RequestBase);
        try
        {
            return callback(scope);
        }
        finally
        {
            CurrentFrame.Value = previous;
        }
    }

    // A server reuses one flow for the requests on a connection, so a request
    // starts from what the flow had before the first one, never from the last.
    public static void PushRequest(string? url)
    {
        var current = CurrentFrame.Value;
        var below = current?.RequestBase ?? Flatten(current);
        var scope = below.Clone();
        scope.SetRequestUrl(url);
        CurrentFrame.Value = new Frame(scope, new Scope(), below);
    }

    // ASP.NET Core and the runtime report an unhandled exception from outside
    // the flow that threw it, which never saw that flow's changes.
    public static void Remember(Exception exception)
    {
        var current = CurrentFrame.Value;
        if (current is not null) Thrown.TryAdd(exception, current);
    }

    private static Scope Over(Frame? frame, Scope below)
    {
        if (frame is null) return below;
        return frame.Local.Over(frame.Shared?.Over(below) ?? below);
    }

    public static Scope Snapshot() => Over(CurrentFrame.Value, Global.Clone());

    public static Scope SnapshotWhereThrown(Exception exception)
    {
        var snapshot = Snapshot();
        return Thrown.TryGetValue(exception, out var thrown) ? Over(thrown, snapshot) : snapshot;
    }

    public static void Reset()
    {
        CurrentFrame.Value = null;
        Global.Clear();
    }
}
