using System;
using System.Collections.Generic;
using System.Linq;
using Instatus.Internal;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Instatus.Otel.Tests;

public class RecordMapperTests
{
    private sealed class PaymentDeclinedException : Exception
    {
        public PaymentDeclinedException(string message) : base(message)
        {
        }
    }

    private static Exception Thrown()
    {
        try
        {
            Charge();
        }
        catch (Exception exception)
        {
            return exception;
        }
        throw new InvalidOperationException("unreachable");
    }

    private static void Charge() =>
        throw new PaymentDeclinedException("card 4111 1111 1111 1111 declined");

    [Fact]
    public void RecordForAnException()
    {
        var exception = Thrown();
        var source = InstatusSdk.EventFromException(exception, true, SeverityLevel.Error);

        var record = RecordMapper.ToRecord(source);

        var type = "Instatus.Otel.Tests.RecordMapperTests+PaymentDeclinedException";
        Assert.Equal(17, record.SeverityNumber);
        Assert.Equal("ERROR", record.SeverityText);
        Assert.Equal(LogLevel.Error, record.LogLevel);
        Assert.Equal($"{type}: card [Filtered] declined", record.Body);
        Assert.Equal(type, record.Attribute("exception.type"));
        Assert.Equal("card [Filtered] declined", record.Attribute("exception.message"));
        Assert.Equal(true, record.Attribute("exception.handled"));
        Assert.Equal(source.EventId, record.Attribute("log.record.uid"));
        Assert.Matches("^[0-9a-f]{32}$", source.EventId);

        var stack = Assert.IsType<string>(record.Attribute("exception.stacktrace"));
        Assert.StartsWith($"{type}: card [Filtered] declined", stack);
        Assert.DoesNotContain("4111", stack);
        Assert.Contains("   at Instatus.Otel.Tests.RecordMapperTests.Charge()", stack);
        Assert.Equal("dotnet", StackFormat.Detect(stack));
    }

    [Fact]
    public void StackFramesParseWithFileAndLine()
    {
        var stack = Assert.IsType<string>(RecordMapper.ToRecord(InstatusSdk.EventFromException(Thrown(), true, SeverityLevel.Error)).Attribute("exception.stacktrace"));

        var frames = stack.Split('\n').Select(line => StackFormat.DotnetFrame.Match(line)).Where(match => match.Success).ToList();

        Assert.Contains(frames, frame => frame.Groups[1].Value == "Instatus.Otel.Tests.RecordMapperTests.Charge()" && frame.Groups[2].Value.EndsWith("RecordMapperTests.cs") && int.Parse(frame.Groups[3].Value) > 0);
    }

    [Fact]
    public async System.Threading.Tasks.Task AsyncAndInnerExceptionStacksAreDetectedAsDotnet()
    {
        Exception caught;
        try
        {
            await FailAsync();
            throw new InvalidOperationException("unreachable");
        }
        catch (Exception exception)
        {
            caught = new InvalidOperationException("checkout failed", exception);
        }
        var stack = InstatusSdk.EventFromException(caught, true, SeverityLevel.Error).Exception!.Stacktrace!;

        Assert.Contains(" ---> System.TimeoutException: gateway", stack);
        Assert.Equal("dotnet", StackFormat.Detect(stack));
    }

    private static async System.Threading.Tasks.Task FailAsync()
    {
        await System.Threading.Tasks.Task.Yield();
        throw new TimeoutException("gateway");
    }

    [Theory]
    [InlineData(SeverityLevel.Fatal, 21, "FATAL", LogLevel.Critical)]
    [InlineData(SeverityLevel.Error, 17, "ERROR", LogLevel.Error)]
    [InlineData(SeverityLevel.Warning, 13, "WARN", LogLevel.Warning)]
    [InlineData(SeverityLevel.Info, 9, "INFO", LogLevel.Information)]
    [InlineData(SeverityLevel.Debug, 5, "DEBUG", LogLevel.Debug)]
    public void SeverityLevels(SeverityLevel level, int number, string text, LogLevel logLevel)
    {
        var record = RecordMapper.ToRecord(new InstatusEvent { Level = level, Message = "hello" });

        Assert.Equal(number, record.SeverityNumber);
        Assert.Equal(text, record.SeverityText);
        Assert.Equal(logLevel, record.LogLevel);
    }

    [Fact]
    public void ErrorMessagesAreIssuesAndLowerLevelsArePlainLogs()
    {
        var error = RecordMapper.ToRecord(new InstatusEvent { Level = SeverityLevel.Error, Message = "webhook signature mismatch" });
        var info = RecordMapper.ToRecord(new InstatusEvent { Level = SeverityLevel.Info, Message = "order placed" });

        Assert.Equal("Error", error.Attribute("exception.type"));
        Assert.Equal("webhook signature mismatch", error.Attribute("exception.message"));
        Assert.Equal("webhook signature mismatch", error.Body);
        Assert.Null(info.Attribute("exception.type"));
        Assert.Equal("order placed", info.Body);
    }

    [Fact]
    public void MetadataAttributes()
    {
        var source = new InstatusEvent
        {
            Message = "boom",
            Tags = new Dictionary<string, string> { ["plan"] = "pro", ["instatus.secret"] = "x" },
            Contexts = new Dictionary<string, object?>
            {
                ["cart"] = new Dictionary<string, object?> { ["items"] = 3, ["coupon"] = "SPRING" },
                ["order"] = new { Id = 42, Total = 9.5 },
                ["region"] = "eu"
            },
            Extra = new Dictionary<string, object?>
            {
                ["attempt"] = 2,
                ["payload"] = new Dictionary<string, object?> { ["token"] = "abc", ["sku"] = "A1" }
            },
            User = new InstatusUser
            {
                Id = "42",
                Email = "ada@example.com",
                Username = "ada",
                IpAddress = "10.0.0.1",
                Other = new Dictionary<string, string> { ["plan"] = "pro" }
            },
            RequestUrl = "https://shop.example.com/checkout?session=abc&step=2"
        };

        var record = RecordMapper.ToRecord(source);

        Assert.Equal("pro", record.Attribute("plan"));
        Assert.Null(record.Attribute("instatus.secret"));
        Assert.Equal(3L, record.Attribute("cart.items"));
        Assert.Equal("SPRING", record.Attribute("cart.coupon"));
        Assert.Equal(42L, record.Attribute("order.Id"));
        Assert.Equal(9.5, record.Attribute("order.Total"));
        Assert.Equal("eu", record.Attribute("region"));
        Assert.Equal(2L, record.Attribute("extra.attempt"));
        Assert.Equal("{\"token\":\"[Filtered]\",\"sku\":\"A1\"}", record.Attribute("extra.payload"));
        Assert.Equal("42", record.Attribute("enduser.id"));
        Assert.Equal("42", record.Attribute("user.id"));
        Assert.Equal("ada@example.com", record.Attribute("user.email"));
        Assert.Equal("ada", record.Attribute("user.name"));
        Assert.Equal("10.0.0.1", record.Attribute("user.ip"));
        Assert.Equal("pro", record.Attribute("user.plan"));
        Assert.Equal("https://shop.example.com/checkout?session=[Filtered]&step=2", record.Attribute("url.full"));
        Assert.Equal("/checkout", record.Attribute("url.path"));
    }

    [Theory]
    [InlineData("42", "ada@example.com", "ada", "42")]
    [InlineData(null, "ada@example.com", "ada", "ada@example.com")]
    [InlineData(null, null, "ada", "ada")]
    public void EndUserPrefersIdThenEmailThenUsername(string? id, string? email, string? username, string expected)
    {
        var record = RecordMapper.ToRecord(new InstatusEvent
        {
            Message = "boom",
            User = new InstatusUser { Id = id, Email = email, Username = username }
        });

        Assert.Equal(expected, record.Attribute("enduser.id"));
    }

    [Fact]
    public void ErrorFieldsWinOverMetadataAndComeFirst()
    {
        var source = InstatusSdk.EventFromException(new InvalidOperationException("real"), true, SeverityLevel.Error);
        source.Tags["exception.message"] = "fake";
        source.Tags["log.record.uid"] = "fake";

        var record = RecordMapper.ToRecord(source);

        Assert.Equal("real", record.Attribute("exception.message"));
        Assert.Equal(source.EventId, record.Attribute("log.record.uid"));
        Assert.Equal("exception.type", record.Attributes[0].Key);
        Assert.Equal(1, record.Attributes.Count(pair => pair.Key == "exception.message"));
    }

    [Fact]
    public void LongValuesAreCut()
    {
        var source = InstatusSdk.EventFromException(new InvalidOperationException(new string('m', 9000)), true, SeverityLevel.Error);
        source.Exception!.Stacktrace = new string('s', 40000);
        source.Extra["blob"] = new string('x', 9000);

        var record = RecordMapper.ToRecord(source);

        Assert.Equal(8192, Assert.IsType<string>(record.Attribute("exception.message")).Length);
        Assert.Equal(32000, Assert.IsType<string>(record.Attribute("exception.stacktrace")).Length);
        Assert.Equal(8192, Assert.IsType<string>(record.Attribute("extra.blob")).Length);
    }

    [Fact]
    public void CuttingKeepsSurrogatePairsWhole()
    {
        var text = new string('a', 8191) + "\U0001F600";

        Assert.Equal(8191, RecordMapper.Cut(text, 8192).Length);
    }

    [Fact]
    public void EmptyValuesAreLeftOut()
    {
        var record = RecordMapper.ToRecord(new InstatusEvent
        {
            Message = "boom",
            Tags = new Dictionary<string, string> { ["empty"] = "" },
            Extra = new Dictionary<string, object?> { ["missing"] = null }
        });

        Assert.Null(record.Attribute("empty"));
        Assert.DoesNotContain(record.Attributes, pair => pair.Key == "extra.missing");
    }
}
