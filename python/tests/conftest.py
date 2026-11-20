from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterator, List

import pytest
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from instatus_otel import scope, state

try:
    from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter as InMemoryLogExporter
except ImportError:
    from opentelemetry.sdk._logs.export import InMemoryLogExporter
from instatus_otel.attributes import ErrorLogRecord
from instatus_otel.client import Client
from instatus_otel.rate_cap import RateCap

PYTHON_STACK = re.compile(r"Traceback \(most recent call last\)")
PYTHON_FRAME = re.compile(r'^\s*File "(.*)", line (\d+)(?:, in (.*))?$', re.MULTILINE)


def is_python_stack(stack: str) -> bool:
    return bool(PYTHON_STACK.search(stack) or PYTHON_FRAME.search(stack))


@dataclass
class Harness:
    records: List[ErrorLogRecord] = field(default_factory=list)
    spans: InMemorySpanExporter = field(default_factory=InMemorySpanExporter)
    logs: InMemoryLogExporter = field(default_factory=InMemoryLogExporter)

    def use_client(self, **options: Any) -> Client:
        options.setdefault("rate_cap", RateCap(300, 60))
        client = Client(emit=self.records.append, **options)
        assert state.runtime is not None
        state.runtime.client = client
        return client


@pytest.fixture(autouse=True)
def clean_scope() -> Iterator[None]:
    token = scope._current.set(None)
    yield
    scope._current.reset(token)
    scope.get_global_scope().clear()


@pytest.fixture
def harness() -> Iterator[Harness]:
    harness = Harness()
    tracer_provider = TracerProvider(shutdown_on_exit=False)
    tracer_provider.add_span_processor(SimpleSpanProcessor(harness.spans))
    logger_provider = LoggerProvider(shutdown_on_exit=False)
    logger_provider.add_log_record_processor(SimpleLogRecordProcessor(harness.logs))
    client = Client(emit=harness.records.append, rate_cap=RateCap(300, 60))
    state.runtime = state.Runtime(client, logger_provider, tracer_provider)
    yield harness
    state.runtime = None
