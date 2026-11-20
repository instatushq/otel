namespace Instatus;

/// <summary>Sentry's severity levels. Error and fatal events are issues in Errors; lower levels are plain logs.</summary>
public enum SeverityLevel
{
    /// <summary>OTel severity 5, DEBUG.</summary>
    Debug,

    /// <summary>OTel severity 9, INFO.</summary>
    Info,

    /// <summary>OTel severity 13, WARN.</summary>
    Warning,

    /// <summary>OTel severity 17, ERROR.</summary>
    Error,

    /// <summary>OTel severity 21, FATAL.</summary>
    Fatal
}
