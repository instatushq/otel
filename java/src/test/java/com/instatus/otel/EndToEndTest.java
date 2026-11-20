package com.instatus.otel;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
import io.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
import io.opentelemetry.proto.common.v1.KeyValue;
import io.opentelemetry.proto.logs.v1.LogRecord;
import io.opentelemetry.proto.trace.v1.Status;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class EndToEndTest {
  private static final class Request {
    final String path;
    final Map<String, String> headers;
    final byte[] body;

    Request(String path, Map<String, String> headers, byte[] body) {
      this.path = path;
      this.headers = headers;
      this.body = body;
    }
  }

  private final List<Request> requests = new CopyOnWriteArrayList<>();
  private HttpServer server;

  @BeforeEach
  void startCollector() throws IOException {
    server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    server.createContext("/", this::record);
    server.start();
  }

  @AfterEach
  void stop() {
    Instatus.close(Duration.ofSeconds(5));
    GlobalOpenTelemetry.resetForTest();
    server.stop(0);
  }

  private void record(HttpExchange exchange) throws IOException {
    Map<String, String> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
    exchange.getRequestHeaders().forEach((name, values) -> headers.put(name, values.get(0)));
    byte[] body = exchange.getRequestBody().readAllBytes();
    if ("gzip".equalsIgnoreCase(headers.get("Content-Encoding"))) body = gunzip(body);
    requests.add(new Request(exchange.getRequestURI().getPath(), headers, body));
    exchange.getResponseHeaders().add("Content-Type", "application/x-protobuf");
    exchange.sendResponseHeaders(200, -1);
    exchange.close();
  }

  private static byte[] gunzip(byte[] body) throws IOException {
    try (InputStream input = new GZIPInputStream(new ByteArrayInputStream(body))) {
      return input.readAllBytes();
    }
  }

  private Request only(String path) {
    List<Request> matching = requests.stream().filter(request -> request.path.equals(path)).collect(Collectors.toList());
    assertEquals(1, matching.size(), "requests to " + path);
    return matching.get(0);
  }

  private static Map<String, String> strings(List<KeyValue> attributes) {
    Map<String, String> values = new TreeMap<>();
    for (KeyValue attribute : attributes) {
      if (attribute.getValue().hasStringValue()) values.put(attribute.getKey(), attribute.getValue().getStringValue());
    }
    return values;
  }

  private static String hex(com.google.protobuf.ByteString bytes) {
    StringBuilder text = new StringBuilder();
    for (byte value : bytes.toByteArray()) text.append(String.format("%02x", value));
    return text.toString();
  }

  @Test
  void exportsErrorsAndTracesOverOtlpProtobuf() throws Exception {
    String endpoint = "http://127.0.0.1:" + server.getAddress().getPort();
    Instatus.init(
        options ->
            options
                .apiKey("sk_test")
                .siteId("site_1")
                .endpoint(endpoint)
                .serviceName("checkout-api")
                .release("checkout@1.4.0")
                .environment("test")
                .loggingLevel(java.util.logging.Level.OFF)
                .environmentVariables(Map.of()));
    AtomicReference<String> traceId = new AtomicReference<>();
    Instatus.startSpan(
        "checkout",
        () -> {
          traceId.set(Span.current().getSpanContext().getTraceId());
          Instatus.captureException(new IllegalStateException("card declined"));
        });
    assertTrue(Instatus.flush(Duration.ofSeconds(10)));

    Request logs = only("/v1/logs");
    Request traces = only("/v1/traces");
    for (Request request : List.of(logs, traces)) {
      assertEquals("Bearer sk_test", request.headers.get("Authorization"));
      assertEquals("site_1", request.headers.get("X-Instatus-Site-Id"));
      assertEquals("application/x-protobuf", request.headers.get("Content-Type"));
    }

    ExportLogsServiceRequest logsRequest = ExportLogsServiceRequest.parseFrom(logs.body);
    Map<String, String> resource = strings(logsRequest.getResourceLogs(0).getResource().getAttributesList());
    assertEquals("checkout-api", resource.get("service.name"));
    assertEquals("checkout@1.4.0", resource.get("service.version"));
    assertEquals("test", resource.get("deployment.environment.name"));
    assertEquals("com.instatus:instatus-otel", resource.get("telemetry.sdk.name"));
    assertEquals("java", resource.get("telemetry.sdk.language"));
    assertNotNull(resource.get("host.name"));

    LogRecord record = logsRequest.getResourceLogs(0).getScopeLogs(0).getLogRecords(0);
    Map<String, String> attributes = strings(record.getAttributesList());
    assertEquals("java.lang.IllegalStateException: card declined", record.getBody().getStringValue());
    assertEquals(17, record.getSeverityNumberValue());
    assertEquals("java.lang.IllegalStateException", attributes.get("exception.type"));
    assertEquals("card declined", attributes.get("exception.message"));
    assertTrue(attributes.get("log.record.uid").matches("[0-9a-f]{32}"));
    String stack = attributes.get("exception.stacktrace");
    assertTrue(stack.contains("\tat com.instatus.otel.EndToEndTest"), stack);
    assertEquals("java", StackLanguage.detect(stack));
    assertEquals(traceId.get(), hex(record.getTraceId()));

    ExportTraceServiceRequest tracesRequest = ExportTraceServiceRequest.parseFrom(traces.body);
    io.opentelemetry.proto.trace.v1.Span span = tracesRequest.getResourceSpans(0).getScopeSpans(0).getSpans(0);
    assertEquals("checkout", span.getName());
    assertEquals(traceId.get(), hex(span.getTraceId()));
    assertEquals(Status.StatusCode.STATUS_CODE_UNSET, span.getStatus().getCode());
    assertEquals("exception", span.getEvents(0).getName());
    assertEquals("java.lang.IllegalStateException", strings(span.getEvents(0).getAttributesList()).get("exception.type"));
  }
}
