using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Instatus.Internal;
using Xunit;

namespace Instatus.Otel.Tests;

[Collection(SdkCollection.Name)]
public class ScopeTests
{
    public ScopeTests() => Scopes.Reset();

    private static InstatusEvent Applied()
    {
        var target = new InstatusEvent();
        Scopes.Snapshot().ApplyTo(target);
        return target;
    }

    [Fact]
    public async Task ConcurrentFlowsKeepTheirOwnUser()
    {
        Scopes.Reset();
        using var bothSet = new Barrier(2);

        async Task<string?> Request(string id)
        {
            await Task.Yield();
            InstatusSdk.SetUser(new InstatusUser { Id = id });
            InstatusSdk.SetTag("request", id);
            bothSet.SignalAndWait();
            await Task.Delay(10);
            var applied = Applied();
            Assert.Equal(id, applied.Tags["request"]);
            return applied.User?.Id;
        }

        var first = Task.Run(() => Request("ada"));
        var second = Task.Run(() => Request("grace"));

        Assert.Equal("ada", await first);
        Assert.Equal("grace", await second);
        Assert.Null(Applied().User);
    }

    [Fact]
    public async Task ChangesInAChildFlowDoNotReachTheParent()
    {
        Scopes.Reset();
        InstatusSdk.SetTag("plan", "pro");

        await Task.Run(() => InstatusSdk.SetTag("plan", "free"));

        Assert.Equal("pro", Applied().Tags["plan"]);
    }

    [Fact]
    public async Task ChildFlowsInheritTheScope()
    {
        Scopes.Reset();
        InstatusSdk.SetUser(new InstatusUser { Email = "ada@example.com" });

        var seen = await Task.Run(() => Applied().User?.Email);

        Assert.Equal("ada@example.com", seen);
    }

    [Fact]
    public void WithScopeGivesACopy()
    {
        Scopes.Reset();
        InstatusSdk.SetTag("plan", "pro");

        var inside = InstatusSdk.WithScope(scope =>
        {
            scope.SetTag("job", "42");
            InstatusSdk.SetExtra("attempt", 2);
            return Applied();
        });
        var outside = Applied();

        Assert.Equal("pro", inside.Tags["plan"]);
        Assert.Equal("42", inside.Tags["job"]);
        Assert.Equal(2, inside.Extra["attempt"]);
        Assert.False(outside.Tags.ContainsKey("job"));
        Assert.False(outside.Extra.ContainsKey("attempt"));
    }

    [Fact]
    public async Task WithScopeFollowsAnAsyncCallback()
    {
        Scopes.Reset();

        await InstatusSdk.WithScope(async scope =>
        {
            scope.SetTag("job", "42");
            await Task.Delay(5);
            Assert.Equal("42", Applied().Tags["job"]);
        });

        Assert.False(Applied().Tags.ContainsKey("job"));
    }

    [Fact]
    public void CurrentScopeWinsOverGlobal()
    {
        Scopes.Reset();
        InstatusSdk.ConfigureScope(scope => scope.SetTag("plan", "free").SetTag("region", "eu"));
        InstatusSdk.SetTag("plan", "pro");

        var applied = Applied();

        Assert.Equal("pro", applied.Tags["plan"]);
        Assert.Equal("eu", applied.Tags["region"]);
    }

    [Fact]
    public void EventValuesWinOverTheScope()
    {
        Scopes.Reset();
        InstatusSdk.SetTag("plan", "pro");
        var target = new InstatusEvent { Tags = new Dictionary<string, string> { ["plan"] = "enterprise" } };

        Scopes.Snapshot().ApplyTo(target);

        Assert.Equal("enterprise", target.Tags["plan"]);
    }

    [Fact]
    public void NullUserAndContextClearThem()
    {
        Scopes.Reset();
        InstatusSdk.SetUser(new InstatusUser { Id = "42" });
        InstatusSdk.SetContext("cart", new { Items = 3 });

        InstatusSdk.SetUser(null);
        InstatusSdk.SetContext("cart", null);

        var applied = Applied();
        Assert.Null(applied.User);
        Assert.False(applied.Contexts.ContainsKey("cart"));
    }

    [Fact]
    public void RequestsOnOneFlowStartFromItsScopeNotTheLastRequest()
    {
        Scopes.Reset();
        InstatusSdk.SetTag("region", "eu");

        Scopes.PushRequest("https://shop.example.com/a");
        InstatusSdk.SetUser(new InstatusUser { Id = "ada" });
        var first = Applied();
        Scopes.PushRequest("https://shop.example.com/b");
        var second = Applied();

        Assert.Equal("ada", first.User?.Id);
        Assert.Equal("https://shop.example.com/a", first.RequestUrl);
        Assert.Null(second.User);
        Assert.Equal("eu", second.Tags["region"]);
        Assert.Equal("https://shop.example.com/b", second.RequestUrl);
    }

    private static async Task<InstatusEvent> ChildAsync(Barrier bothSet, string id)
    {
        await Task.Yield();
        InstatusSdk.SetUser(new InstatusUser { Id = id });
        InstatusSdk.SetTag("child", id);
        bothSet.SignalAndWait();
        await Task.Delay(10);
        return Applied();
    }

    private static async Task<(InstatusEvent First, InstatusEvent Second)> TwoChildrenAsync()
    {
        using var bothSet = new Barrier(2);
        var first = Task.Run(() => ChildAsync(bothSet, "ada"));
        var second = Task.Run(() => ChildAsync(bothSet, "grace"));
        return (await first, await second);
    }

    private static void AssertChildrenKeptTheirOwn(InstatusEvent first, InstatusEvent second)
    {
        Assert.Equal("ada", first.User?.Id);
        Assert.Equal("ada", first.Tags["child"]);
        Assert.Equal("grace", second.User?.Id);
        Assert.Equal("grace", second.Tags["child"]);
    }

    [Fact]
    public async Task TasksStartedInsideWithScopeDoNotChangeItOrEachOther()
    {
        Scopes.Reset();

        var (parent, after, first, second) = await InstatusSdk.WithScope(async scope =>
        {
            scope.SetTag("job", "42");
            InstatusSdk.SetUser(new InstatusUser { Id = "owner" });
            var (first, second) = await TwoChildrenAsync();
            var parent = Applied();
            InstatusSdk.SetUser(new InstatusUser { Id = "next" });
            return (parent, Applied(), first, second);
        });

        AssertChildrenKeptTheirOwn(first, second);
        Assert.Equal("42", first.Tags["job"]);
        Assert.Equal("owner", parent.User?.Id);
        Assert.False(parent.Tags.ContainsKey("child"));
        Assert.Equal("next", after.User?.Id);
        Assert.Equal("42", after.Tags["job"]);
    }

    [Fact]
    public async Task TasksStartedInsideARequestDoNotChangeItOrEachOther()
    {
        Scopes.Reset();
        Scopes.PushRequest("https://shop.example.com/checkout");
        InstatusSdk.SetUser(new InstatusUser { Id = "owner" });

        var (first, second) = await TwoChildrenAsync();
        var parent = Applied();
        InstatusSdk.SetTag("step", "charge");
        var after = Applied();

        AssertChildrenKeptTheirOwn(first, second);
        Assert.Equal("https://shop.example.com/checkout", first.RequestUrl);
        Assert.Equal("owner", parent.User?.Id);
        Assert.False(parent.Tags.ContainsKey("child"));
        Assert.Equal("owner", after.User?.Id);
        Assert.Equal("charge", after.Tags["step"]);
    }

    [Fact]
    public async Task AnUnhandledErrorCarriesTheScopeItWasThrownIn()
    {
        Scopes.Reset();
        Scopes.PushRequest("https://shop.example.com/checkout");

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(ThrowAsUserAsync);
        var reported = new InstatusEvent();
        Scopes.SnapshotWhereThrown(exception).ApplyTo(reported);

        Assert.Equal("ada", reported.User?.Id);
        Assert.Equal("https://shop.example.com/checkout", reported.RequestUrl);
        Assert.Null(Applied().User);
    }

    private static async Task ThrowAsUserAsync()
    {
        await Task.Yield();
        InstatusSdk.SetUser(new InstatusUser { Id = "ada" });
        var exception = new InvalidOperationException("declined");
        Scopes.Remember(exception);
        throw exception;
    }

    [Fact]
    public void ClearingAValueHidesTheOneWithScopeSet()
    {
        var applied = InstatusSdk.WithScope(scope =>
        {
            scope.SetUser(new InstatusUser { Id = "ada" });
            scope.SetContext("cart", new { Items = 3 });
            scope.SetTag("plan", "pro");
            InstatusSdk.SetUser(null);
            InstatusSdk.SetContext("cart", null);
            Scopes.Change(current => current.UnsetTag("plan"));
            return Applied();
        });

        Assert.Null(applied.User);
        Assert.False(applied.Contexts.ContainsKey("cart"));
        Assert.False(applied.Tags.ContainsKey("plan"));
    }

    [Fact]
    public void ClearingTheUserHidesTheGlobalOne()
    {
        Scopes.Global.SetUser(new InstatusUser { Id = "boot" });
        InstatusSdk.WithScope(_ =>
        {
            InstatusSdk.SetUser(null);
            Assert.Null(Applied().User);
        });
        Assert.Equal("boot", Applied().User?.Id);
    }

    [Fact]
    public void SettingAValueAgainAfterClearingItShowsIt()
    {
        InstatusSdk.WithScope(scope =>
        {
            scope.SetUser(new InstatusUser { Id = "ada" });
            InstatusSdk.SetUser(null);
            InstatusSdk.SetUser(new InstatusUser { Id = "grace" });
            Assert.Equal("grace", Applied().User?.Id);
        });
    }
}
