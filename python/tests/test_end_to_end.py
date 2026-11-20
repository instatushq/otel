from __future__ import annotations

import gzip
import logging
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, Iterator, List

import pytest
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

import instatus_otel

from .conftest import PYTHON_FRAME, is_python_stack


@dataclass
class Request:
    path: str
    headers: Dict[str, str]
    body: bytes


@dataclass
class Collector:
    url: str
    requests: List[Request] = field(default_factory=list)

    def bodies(self, path: str) -> List[bytes]:
        return [request.body for request in self.requests if request.path == path]


@pytest.fixture
def collector() -> Iterator[Collector]:
    received: List[Request] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            received.append(Request(self.path, {key.lower(): value for key, value in self.headers.items()}, body))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield Collector(f"http://127.0.0.1:{server.server_address[1]}", received)
    server.shutdown()
    server.server_close()


class CheckoutError(Exception):
    pass


def charge_card() -> None:
    raise CheckoutError("card 4111 1111 1111 1111 declined")


def attributes_of(items: Iterable[Any]) -> Dict[str, Any]:
    return {item.key: getattr(item.value, item.value.WhichOneof("value")) for item in items}


def test_init_exports_errors_logs_and_traces(collector: Collector) -> None:
    instatus_otel.init(
        api_key="sk_test",
        site_id="site_1",
        endpoint=collector.url,
        service_name="checkout",
        release="api@1.4.0",
        environment="test",
    )
    try:
        instatus_otel.set_tag("region", "eu")
        with instatus_otel.start_span("checkout") as span:
            instatus_otel.set_user({"id": "user-1"})
            try:
                charge_card()
            except CheckoutError:
                event_id = instatus_otel.capture_exception()
            logging.getLogger("checkout").warning("charge failed for order %s", 1042)
        assert instatus_otel.flush(5.0)
    finally:
        assert instatus_otel.close(5.0)

    paths = {request.path for request in collector.requests}
    assert {"/v1/logs", "/v1/traces"} <= paths
    for request in collector.requests:
        assert request.headers["authorization"] == "Bearer sk_test"
        assert request.headers["x-instatus-site-id"] == "site_1"
        assert request.headers["content-type"] == "application/x-protobuf"

    trace_id = span.get_span_context().trace_id.to_bytes(16, "big")
    resource_logs = [
        resource_log
        for body in collector.bodies("/v1/logs")
        for resource_log in ExportLogsServiceRequest.FromString(body).resource_logs
    ]
    resource = attributes_of(resource_logs[0].resource.attributes)
    assert resource["service.name"] == "checkout"
    assert resource["service.version"] == "api@1.4.0"
    assert resource["deployment.environment.name"] == "test"
    assert resource["telemetry.sdk.name"] == "instatus-otel"
    assert resource["telemetry.sdk.language"] == "python"

    records = {
        scope_log.scope.name: list(scope_log.log_records)
        for resource_log in resource_logs
        for scope_log in resource_log.scope_logs
    }
    (error,) = records["instatus-otel"]
    attributes = attributes_of(error.attributes)
    assert error.severity_number == 17
    assert error.body.string_value == f"{__name__}.CheckoutError: card [Filtered] declined"
    assert error.trace_id == trace_id
    assert attributes["exception.type"] == f"{__name__}.CheckoutError"
    assert attributes["exception.message"] == "card [Filtered] declined"
    assert attributes["exception.handled"] is True
    assert attributes["log.record.uid"] == event_id
    assert attributes["enduser.id"] == "user-1"
    assert attributes["region"] == "eu"
    stack = attributes["exception.stacktrace"]
    assert stack.startswith("Traceback (most recent call last):")
    assert is_python_stack(stack)
    assert [match.group(3) for match in PYTHON_FRAME.finditer(stack)][-1] == "charge_card"
    assert "4111" not in stack

    (logged,) = records["checkout"]
    assert logged.body.string_value == "charge failed for order 1042"
    assert logged.severity_text == "WARN"
    assert logged.trace_id == trace_id

    spans = [
        exported_span
        for body in collector.bodies("/v1/traces")
        for resource_span in ExportTraceServiceRequest.FromString(body).resource_spans
        for scope_span in resource_span.scope_spans
        for exported_span in scope_span.spans
    ]
    (checkout,) = spans
    assert checkout.name == "checkout"
    assert checkout.trace_id == trace_id
    assert attributes_of(checkout.attributes)["enduser.id"] == "user-1"
    (exception_event,) = checkout.events
    assert exception_event.name == "exception"
    assert attributes_of(exception_event.attributes)["exception.message"] == (
        "card [Filtered] declined"
    )


def run_app(collector: Collector, body: str) -> "subprocess.CompletedProcess[str]":
    script = (
        "import instatus_otel\n"
        f"instatus_otel.init(api_key='sk_test', site_id='site_1', endpoint={collector.url!r})\n"
        f"{body}\n"
    )
    return subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=30
    )


def error_records(collector: Collector) -> List[Dict[str, Any]]:
    return [
        attributes_of(record.attributes)
        for body in collector.bodies("/v1/logs")
        for resource_log in ExportLogsServiceRequest.FromString(body).resource_logs
        for scope_log in resource_log.scope_logs
        for record in scope_log.log_records
    ]


def test_uncaught_exceptions_are_sent_before_the_process_exits(collector: Collector) -> None:
    result = run_app(collector, "def main():\n    raise LookupError('no such order')\nmain()")
    assert result.returncode == 1
    assert "LookupError: no such order" in result.stderr
    (attributes,) = error_records(collector)
    assert attributes["exception.type"] == "LookupError"
    assert attributes["exception.handled"] is False
    assert is_python_stack(attributes["exception.stacktrace"])


def test_a_normal_exit_flushes_what_is_queued(collector: Collector) -> None:
    result = run_app(collector, "instatus_otel.capture_message('Nightly job failed', 'error')")
    assert result.returncode == 0, result.stderr
    (attributes,) = error_records(collector)
    assert attributes["exception.message"] == "Nightly job failed"
