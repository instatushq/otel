using System.Collections.Generic;

namespace Instatus;

/// <summary>The user, tags, contexts and extras that events captured inside it carry.</summary>
public sealed class Scope
{
    private readonly object gate = new();
    private readonly Dictionary<string, string> tags = new();
    private readonly Dictionary<string, object?> contexts = new();
    private readonly Dictionary<string, object?> extra = new();
    private readonly HashSet<string> removedTags = new();
    private readonly HashSet<string> removedContexts = new();
    private InstatusUser? user;
    private string? requestUrl;
    private bool userRemoved;
    private bool cleared;

    /// <summary>Who events in this scope affected.</summary>
    public InstatusUser? User
    {
        get
        {
            lock (gate) return user;
        }
    }

    /// <summary>Sets the user. <c>null</c> clears it.</summary>
    public Scope SetUser(InstatusUser? value)
    {
        lock (gate)
        {
            user = value?.Clone();
            userRemoved = value is null;
        }
        return this;
    }

    /// <summary>Sets a tag, sent as an attribute under its own key.</summary>
    public Scope SetTag(string key, string value)
    {
        lock (gate)
        {
            tags[key] = value;
            removedTags.Remove(key);
        }
        return this;
    }

    /// <summary>Sets several tags.</summary>
    public Scope SetTags(IEnumerable<KeyValuePair<string, string>> values)
    {
        lock (gate)
        {
            foreach (var (key, value) in values)
            {
                tags[key] = value;
                removedTags.Remove(key);
            }
        }
        return this;
    }

    /// <summary>Removes a tag.</summary>
    public Scope UnsetTag(string key)
    {
        lock (gate)
        {
            tags.Remove(key);
            removedTags.Add(key);
        }
        return this;
    }

    /// <summary>
    /// Sets a context, sent as <c>&lt;name&gt;.&lt;key&gt;</c> attributes. It can be a dictionary or an object,
    /// such as <c>new { Items = 3 }</c>. <c>null</c> removes it.
    /// </summary>
    public Scope SetContext(string name, object? value)
    {
        lock (gate)
        {
            if (value is null)
            {
                contexts.Remove(name);
                removedContexts.Add(name);
            }
            else
            {
                contexts[name] = value;
                removedContexts.Remove(name);
            }
        }
        return this;
    }

    /// <summary>Sets an extra, sent as an <c>extra.&lt;key&gt;</c> attribute.</summary>
    public Scope SetExtra(string key, object? value)
    {
        lock (gate) extra[key] = value;
        return this;
    }

    /// <summary>Sets the URL of the request events in this scope happened in.</summary>
    public Scope SetRequestUrl(string? url)
    {
        lock (gate) requestUrl = url;
        return this;
    }

    /// <summary>Removes everything from the scope.</summary>
    public Scope Clear()
    {
        lock (gate)
        {
            ClearValues();
            removedTags.Clear();
            removedContexts.Clear();
            userRemoved = false;
            cleared = true;
        }
        return this;
    }

    private void ClearValues()
    {
        user = null;
        requestUrl = null;
        tags.Clear();
        contexts.Clear();
        extra.Clear();
    }

    internal Scope Clone()
    {
        var copy = new Scope();
        lock (gate) copy.MergeFrom(this);
        return copy;
    }

    internal Scope Over(Scope? below)
    {
        var merged = below?.Clone() ?? new Scope();
        lock (gate) merged.MergeFrom(this);
        return merged;
    }

    // Removals are kept as markers, so a scope laid over another hides what
    // it removed instead of letting the value below show through.
    private void MergeFrom(Scope source)
    {
        if (source.cleared)
        {
            ClearValues();
            removedTags.Clear();
            removedContexts.Clear();
            cleared = true;
        }
        if (source.userRemoved)
        {
            user = null;
            userRemoved = true;
        }
        foreach (var key in source.removedTags)
        {
            tags.Remove(key);
            removedTags.Add(key);
        }
        foreach (var name in source.removedContexts)
        {
            contexts.Remove(name);
            removedContexts.Add(name);
        }
        if (source.user is not null)
        {
            user = source.user.Clone();
            userRemoved = false;
        }
        if (source.requestUrl is not null) requestUrl = source.requestUrl;
        foreach (var (key, value) in source.tags)
        {
            tags[key] = value;
            removedTags.Remove(key);
        }
        foreach (var (key, value) in source.contexts)
        {
            contexts[key] = value;
            removedContexts.Remove(key);
        }
        foreach (var (key, value) in source.extra) extra[key] = value;
    }

    internal void ApplyTo(InstatusEvent target)
    {
        lock (gate)
        {
            target.User ??= user?.Clone();
            target.RequestUrl ??= requestUrl;
            foreach (var (key, value) in tags) target.Tags.TryAdd(key, value);
            foreach (var (key, value) in contexts) target.Contexts.TryAdd(key, value);
            foreach (var (key, value) in extra) target.Extra.TryAdd(key, value);
        }
    }
}
