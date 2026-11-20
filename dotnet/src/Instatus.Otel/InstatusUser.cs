using System.Collections.Generic;

namespace Instatus;

/// <summary>Who an event affected. <see cref="Id"/>, else <see cref="Email"/>, else <see cref="Username"/>, becomes <c>enduser.id</c>.</summary>
public sealed class InstatusUser
{
    /// <summary>Sent as <c>user.id</c>.</summary>
    public string? Id { get; set; }

    /// <summary>Sent as <c>user.email</c>.</summary>
    public string? Email { get; set; }

    /// <summary>Sent as <c>user.name</c>.</summary>
    public string? Username { get; set; }

    /// <summary>Sent as <c>user.ip</c>.</summary>
    public string? IpAddress { get; set; }

    /// <summary>Anything else, sent as <c>user.&lt;key&gt;</c>.</summary>
    public IDictionary<string, string> Other { get; set; } = new Dictionary<string, string>();

    internal InstatusUser Clone() => new()
    {
        Id = Id,
        Email = Email,
        Username = Username,
        IpAddress = IpAddress,
        Other = new Dictionary<string, string>(Other)
    };
}
