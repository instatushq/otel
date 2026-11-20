using System;
using System.Collections.Generic;
using System.Linq;
using Instatus.Internal;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Instatus.Otel.Tests;

public partial class FilteredLogStateTests
{
    private sealed class Recorder : ILogger
    {
        public IEnumerable<KeyValuePair<string, object?>>? State { get; private set; }

        public Func<string>? Render { get; private set; }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            State = (IEnumerable<KeyValuePair<string, object?>>)state!;
            Render = () => formatter(state, exception);
        }
    }

    private static (string Message, Dictionary<string, object?> Values) Filter(Action<ILogger> log)
    {
        var recorder = new Recorder();
        log(recorder);
        var filtered = FilteredLogState.From(recorder.State!, recorder.Render!);
        return (FilteredLogState.Format(filtered, null), filtered.ToDictionary(entry => entry.Key, entry => entry.Value));
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "login {password} for {User}")]
    private static partial void LogLogin(ILogger logger, string user, string password);

    [Fact]
    public void SensitiveValuesAndCardNumbersAreFilteredInValuesAndMessage()
    {
        var (message, values) = Filter(logger => logger.LogInformation("login {Password} card {Card}", "hunter2", "4111 1111 1111 1111"));

        Assert.Equal("login [Filtered] card [Filtered]", message);
        Assert.Equal("[Filtered]", values["Password"]);
        Assert.Equal("[Filtered]", values["Card"]);
        Assert.Equal("login {Password} card {Card}", values["{OriginalFormat}"]);
    }

    [Fact]
    public void UrlsLoseCredentialsAndSecretParameters()
    {
        var (message, values) = Filter(logger =>
            logger.LogInformation("calling {Endpoint}", "https://ada:pw@api.example.com/charge?token=abc&id=1"));

        Assert.Equal("calling https://api.example.com/charge?token=[Filtered]&id=1", message);
        Assert.Equal("https://api.example.com/charge?token=[Filtered]&id=1", values["Endpoint"]);
    }

    [Fact]
    public void ACleanLogKeepsItsMessageAndValues()
    {
        var (message, values) = Filter(logger => logger.LogInformation("order {Id} placed with {Items,6:N0} items", "A1", 1200));

        Assert.Equal("order A1 placed with  1,200 items", message);
        Assert.Equal("A1", values["Id"]);
        Assert.Equal(1200, values["Items"]);
    }

    [Fact]
    public void FormattingIsKeptWhenTheMessageIsRenderedAgain()
    {
        var (message, _) = Filter(logger =>
            logger.LogInformation("{Count:N0} attempts with {Token} {{braces}}", 1200, "abc"));

        Assert.Equal("1,200 attempts with [Filtered] {braces}", message);
    }

    [Fact]
    public void GeneratedLoggersMatchValuesByName()
    {
        var (message, values) = Filter(logger => LogLogin(logger, "ada", "hunter2"));

        Assert.Equal("login [Filtered] for ada", message);
        Assert.Equal("[Filtered]", values["password"]);
        Assert.Equal("ada", values["User"]);
    }

    [Fact]
    public void ObjectsWithSecretsAreSentFiltered()
    {
        var (message, values) = Filter(logger =>
            logger.LogInformation("signed in {Account}", new { Email = "ada@example.com", Password = "hunter2" }));

        Assert.Equal("""{"Email":"ada@example.com","Password":"[Filtered]"}""", values["Account"]);
        Assert.Equal("""signed in {"Email":"ada@example.com","Password":"[Filtered]"}""", message);
    }

    [Fact]
    public void CardNumbersInTheTemplateAreFiltered()
    {
        var (message, _) = Filter(logger => logger.LogInformation("charged 4111-1111-1111-1111"));

        Assert.Equal("charged [Filtered]", message);
    }
}
