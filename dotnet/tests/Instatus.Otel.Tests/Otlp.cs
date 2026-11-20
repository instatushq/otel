using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using Google.Protobuf;

namespace Instatus.Otel.Tests;

// Reads OTLP protobuf by field number, enough for the tests to check what the
// exporter sent without generating code from the .proto files.
internal sealed class ProtoMessage
{
    private readonly Dictionary<int, List<object>> fields = new();

    public static ProtoMessage Parse(ByteString bytes) => Parse(bytes.ToByteArray());

    public static ProtoMessage Parse(byte[] bytes)
    {
        var message = new ProtoMessage();
        var input = new CodedInputStream(bytes);
        uint tag;
        while ((tag = input.ReadTag()) != 0)
        {
            var number = WireFormat.GetTagFieldNumber(tag);
            object value = WireFormat.GetTagWireType(tag) switch
            {
                WireFormat.WireType.Varint => input.ReadUInt64(),
                WireFormat.WireType.Fixed64 => input.ReadFixed64(),
                WireFormat.WireType.Fixed32 => input.ReadFixed32(),
                WireFormat.WireType.LengthDelimited => input.ReadBytes(),
                var other => throw new InvalidOperationException($"unexpected wire type {other}")
            };
            if (!message.fields.TryGetValue(number, out var values)) message.fields[number] = values = new List<object>();
            values.Add(value);
        }
        return message;
    }

    private IEnumerable<object> All(int number) => fields.TryGetValue(number, out var values) ? values : Enumerable.Empty<object>();

    public IEnumerable<ProtoMessage> Messages(int number) => All(number).Cast<ByteString>().Select(Parse);

    public ProtoMessage? Message(int number) => Messages(number).FirstOrDefault();

    public string? String(int number) => All(number).Cast<ByteString>().Select(bytes => bytes.ToStringUtf8()).FirstOrDefault();

    public byte[]? Bytes(int number) => All(number).Cast<ByteString>().Select(bytes => bytes.ToByteArray()).FirstOrDefault();

    public ulong? Varint(int number) => All(number).OfType<ulong>().Cast<ulong?>().FirstOrDefault();
}

internal static class Otlp
{
    public static object? ValueOf(ProtoMessage? anyValue)
    {
        if (anyValue is null) return null;
        if (anyValue.String(1) is { } text) return text;
        if (anyValue.Varint(2) is { } flag) return flag != 0;
        if (anyValue.Varint(3) is { } number) return (long)number;
        return null;
    }

    public static Dictionary<string, object?> Attributes(ProtoMessage message, int number) =>
        message.Messages(number)
            .GroupBy(pair => pair.String(1) ?? "")
            .ToDictionary(group => group.Key, group => ValueOf(group.Last().Message(2)));

    public static IEnumerable<(Dictionary<string, object?> Resource, string Scope, ProtoMessage Record)> LogRecords(byte[] body)
    {
        foreach (var resourceLogs in ProtoMessage.Parse(body).Messages(1))
        {
            var resource = Attributes(resourceLogs.Message(1)!, 1);
            foreach (var scopeLogs in resourceLogs.Messages(2))
            {
                var scope = scopeLogs.Message(1)?.String(1) ?? "";
                foreach (var record in scopeLogs.Messages(2)) yield return (resource, scope, record);
            }
        }
    }

    public static IEnumerable<ProtoMessage> Spans(byte[] body) =>
        ProtoMessage.Parse(body).Messages(1).SelectMany(resource => resource.Messages(2)).SelectMany(scope => scope.Messages(2));
}

internal sealed record ReceivedRequest(string Path, IReadOnlyDictionary<string, string> Headers, byte[] Body);

internal sealed class Collector : IDisposable
{
    private readonly HttpListener listener = new();
    private readonly List<ReceivedRequest> requests = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly Task loop;

    public Collector()
    {
        Port = FreePort();
        listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        listener.Start();
        loop = Task.Run(ServeAsync);
    }

    public int Port { get; }

    public string Endpoint => $"http://127.0.0.1:{Port}";

    private static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private async Task ServeAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception) when (stopping.IsCancellationRequested)
            {
                return;
            }
            using var body = new System.IO.MemoryStream();
            await context.Request.InputStream.CopyToAsync(body).ConfigureAwait(false);
            var headers = context.Request.Headers.AllKeys
                .Where(key => key is not null)
                .ToDictionary(key => key!, key => context.Request.Headers[key] ?? "", StringComparer.OrdinalIgnoreCase);
            lock (requests) requests.Add(new ReceivedRequest(context.Request.Url!.AbsolutePath, headers, body.ToArray()));
            context.Response.StatusCode = 200;
            context.Response.ContentType = "application/x-protobuf";
            context.Response.Close();
        }
    }

    public IReadOnlyList<ReceivedRequest> On(string path)
    {
        lock (requests) return requests.Where(request => request.Path == path).ToList();
    }

    public List<(Dictionary<string, object?> Resource, string Scope, ProtoMessage Record)> LogRecords() =>
        On("/v1/logs").SelectMany(request => Otlp.LogRecords(request.Body)).ToList();

    public List<ProtoMessage> Spans() => On("/v1/traces").SelectMany(request => Otlp.Spans(request.Body)).ToList();

    public void Dispose()
    {
        stopping.Cancel();
        listener.Stop();
        listener.Close();
        try
        {
            loop.Wait(TimeSpan.FromSeconds(2));
        }
        catch (AggregateException)
        {
        }
    }
}
