using System;
using System.Collections.Generic;
using System.Linq;
using Instatus.Internal;
using Xunit;

namespace Instatus.Otel.Tests;

public class ScrubberTests
{
    [Theory]
    [InlineData("password", true)]
    [InlineData("PASSWD", true)]
    [InlineData("pass", true)]
    [InlineData("client_secret", true)]
    [InlineData("accessToken", true)]
    [InlineData("api_key", true)]
    [InlineData("X-Api-Key", true)]
    [InlineData("apikey", true)]
    [InlineData("Authorization", true)]
    [InlineData("credentials", true)]
    [InlineData("sessionId", true)]
    [InlineData("Cookie", true)]
    [InlineData("csrf_token", true)]
    [InlineData("xsrf", true)]
    [InlineData("private.key", true)]
    [InlineData("signature", true)]
    [InlineData("email", false)]
    [InlineData("plan", false)]
    [InlineData("order_id", false)]
    public void SensitiveKeys(string key, bool sensitive) => Assert.Equal(sensitive, Scrubber.IsSensitiveKey(key));

    [Theory]
    [InlineData("card 4111111111111111 declined", "card [Filtered] declined")]
    [InlineData("card 4111 1111 1111 1111 declined", "card [Filtered] declined")]
    [InlineData("card 4111-1111-1111-1111", "card [Filtered]")]
    [InlineData("amex 378282246310005", "amex [Filtered]")]
    [InlineData("order 1234567890123456", "order 1234567890123456")]
    [InlineData("at 1700000000000", "at 1700000000000")]
    [InlineData("short 4111", "short 4111")]
    public void ScrubTextFiltersCardNumbersThatPassLuhn(string text, string expected) =>
        Assert.Equal(expected, Scrubber.ScrubText(text));

    [Theory]
    [InlineData("https://ada:hunter2@example.com/path", "https://example.com/path")]
    [InlineData("https://example.com/cb?code=1&access_token=abc&state=x", "https://example.com/cb?code=1&access_token=[Filtered]&state=x")]
    [InlineData("https://example.com/cb#id_token=abc&expires=3600", "https://example.com/cb#id_token=[Filtered]&expires=3600")]
    [InlineData("https://example.com/?api%5Fkey=abc", "https://example.com/?api%5Fkey=[Filtered]")]
    [InlineData("https://example.com/pay?number=4111111111111111", "https://example.com/pay?number=[Filtered]")]
    [InlineData("https://example.com/orders?page=2", "https://example.com/orders?page=2")]
    public void ScrubUrl(string url, string expected) => Assert.Equal(expected, Scrubber.ScrubUrl(url));

    [Fact]
    public void ScrubValueWalksDictionariesAndLists()
    {
        var value = new Dictionary<string, object?>
        {
            ["user"] = new Dictionary<string, object?> { ["name"] = "ada", ["password"] = "hunter2" },
            ["cards"] = new List<object?> { "4111 1111 1111 1111", new Dictionary<string, string> { ["token"] = "tok_1" } },
            ["callback_url"] = "https://example.com/?token=abc",
            ["count"] = 3
        };

        var scrubbed = Assert.IsType<Dictionary<string, object?>>(Scrubber.ScrubValue("payload", value));

        var user = Assert.IsType<Dictionary<string, object?>>(scrubbed["user"]);
        Assert.Equal("ada", user["name"]);
        Assert.Equal(Scrubber.Filtered, user["password"]);
        var cards = Assert.IsType<List<object?>>(scrubbed["cards"]);
        Assert.Equal(Scrubber.Filtered, cards[0]);
        Assert.Equal(Scrubber.Filtered, Assert.IsType<Dictionary<string, object?>>(cards[1])["token"]);
        Assert.Equal("https://example.com/?token=[Filtered]", scrubbed["callback_url"]);
        Assert.Equal(3, scrubbed["count"]);
    }

    [Fact]
    public void ScrubValueFiltersTheWholeValueUnderASensitiveKey() =>
        Assert.Equal(Scrubber.Filtered, Scrubber.ScrubValue("credentials", new { User = "ada", Pin = 1234 }));

    private sealed class Checkout
    {
        public string Email { get; set; } = "ada@example.com";
        public string Password { get; set; } = "hunter2";
        public string Throws => throw new InvalidOperationException("no");
    }

    [Fact]
    public void ScrubValueReadsObjectsThroughTheirProperties()
    {
        var scrubbed = Assert.IsType<Dictionary<string, object?>>(Scrubber.ScrubValue("checkout", new Checkout()));

        Assert.Equal("ada@example.com", scrubbed["Email"]);
        Assert.Equal(Scrubber.Filtered, scrubbed["Password"]);
        Assert.Equal("[Unreadable]", scrubbed["Throws"]);
    }

    [Fact]
    public void ScrubValueReadsAnonymousObjects()
    {
        var scrubbed = Assert.IsType<Dictionary<string, object?>>(Scrubber.ScrubValue("request", new { Path = "/pay", ApiKey = "sk_live" }));

        Assert.Equal("/pay", scrubbed["Path"]);
        Assert.Equal(Scrubber.Filtered, scrubbed["ApiKey"]);
    }

    [Fact]
    public void ScrubValueStopsAtDepthSix()
    {
        object nested = "leaf";
        for (var level = 0; level < 8; level++) nested = new Dictionary<string, object?> { ["next"] = nested };

        var current = Scrubber.ScrubValue("root", nested);
        for (var level = 0; level < 6; level++) current = Assert.IsType<Dictionary<string, object?>>(current)["next"];

        Assert.Equal("[Truncated]", current);
    }

    [Fact]
    public void ScrubValueCutsCyclesButKeepsSharedValues()
    {
        var address = new Dictionary<string, object?> { ["city"] = "Paris" };
        var order = new Dictionary<string, object?> { ["billing"] = address, ["shipping"] = address };
        order["self"] = order;
        var items = new List<object?>();
        items.Add(items);

        var scrubbed = Assert.IsType<Dictionary<string, object?>>(Scrubber.ScrubValue("order", order));

        Assert.Equal("Paris", Assert.IsType<Dictionary<string, object?>>(scrubbed["billing"])["city"]);
        Assert.Equal("Paris", Assert.IsType<Dictionary<string, object?>>(scrubbed["shipping"])["city"]);
        Assert.Equal("[Circular]", scrubbed["self"]);
        Assert.Equal("[Circular]", Assert.IsType<List<object?>>(Scrubber.ScrubValue("items", items))[0]);
    }

    [Fact]
    public void ScrubValueKeepsScalarsAndSkipsLazySequences()
    {
        Assert.Equal(42L, Scrubber.ScrubValue("count", 42L));
        Assert.Equal(true, Scrubber.ScrubValue("ok", true));
        Assert.Equal("Monday", Scrubber.ScrubValue("day", DayOfWeek.Monday));
        Assert.Null(Scrubber.ScrubValue("missing", null));
        var runs = 0;
        var lazy = Enumerable.Range(0, 3).Select(index =>
        {
            runs++;
            return index;
        });
        Assert.IsType<string>(Scrubber.ScrubValue("lazy", lazy));
        Assert.Equal(0, runs);
    }

    [Fact]
    public void ScrubValueFiltersCardNumbersInStrings() =>
        Assert.Equal("paid with [Filtered]", Scrubber.ScrubValue("note", "paid with 4111 1111 1111 1111"));
}
