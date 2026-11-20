from __future__ import annotations

import atexit
import logging
import os
import sys
import threading
import time
from types import TracebackType
from typing import Any, Callable, Iterable, Optional, Protocol, Type

from opentelemetry import _logs, context, metrics, propagate, trace
from opentelemetry._logs import LogRecord, SeverityNumber
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from . import state
from .api import capture_error
from .attributes import ErrorLogRecord
from .client import BeforeSend, Client, logger
from .exports import SignalExport, resolve_exports
from .logging_handler import InstatusLoggingHandler
from .rate_cap import RateCap
from .resource import build_resource
from .version import SDK_NAME, __version__

DEFAULT_TIMEOUT = 2.0
DEFAULT_MAX_EVENTS_PER_MINUTE = 300
_MINUTE = 60.0


class Instrumentor(Protocol):
    def instrument(self, **kwargs: Any) -> Any: ...

    def uninstrument(self, **kwargs: Any) -> Any: ...


def _logger_provider(resource: Resource, target: Optional[SignalExport]) -> LoggerProvider:
    provider = LoggerProvider(resource=resource, shutdown_on_exit=False)
    if target:
        exporter = OTLPLogExporter(endpoint=target.url, headers=target.headers)
        provider.add_log_record_processor(BatchLogRecordProcessor(exporter))
    return provider


def _tracer_provider(
    resource: Resource, target: Optional[SignalExport], sample_rate: float
) -> TracerProvider:
    provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(sample_rate)),
        shutdown_on_exit=False,
    )
    if target:
        exporter = OTLPSpanExporter(endpoint=target.url, headers=target.headers)
        provider.add_span_processor(BatchSpanProcessor(exporter))
    return provider


def _meter_provider(resource: Resource, target: SignalExport) -> MeterProvider:
    exporter = OTLPMetricExporter(endpoint=target.url, headers=target.headers)
    return MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(exporter)],
        shutdown_on_exit=False,
    )


def _emitter(provider: LoggerProvider) -> Callable[[ErrorLogRecord], None]:
    otel_logger = provider.get_logger(SDK_NAME, __version__)

    def emit(record: ErrorLogRecord) -> None:
        otel_logger.emit(
            LogRecord(
                timestamp=record.timestamp_ns,
                observed_timestamp=time.time_ns(),
                context=context.get_current(),
                severity_number=SeverityNumber(record.severity_number),
                severity_text=record.severity_text,
                body=record.body,
                attributes=record.attributes,
            )
        )

    return emit


def _set_globals(runtime: state.Runtime) -> None:
    trace.set_tracer_provider(runtime.tracer_provider)
    _logs.set_logger_provider(runtime.logger_provider)
    if runtime.meter_provider is not None:
        metrics.set_meter_provider(runtime.meter_provider)
    if not os.environ.get("OTEL_PROPAGATORS"):
        propagate.set_global_textmap(
            CompositePropagator([TraceContextTextMapPropagator(), W3CBaggagePropagator()])
        )


def _capture_uncaught(
    error_type: Type[BaseException], error: BaseException, tb: Optional[TracebackType]
) -> None:
    try:
        capture_error(
            (error_type, error, tb), {"type": "excepthook", "handled": False}, level="fatal"
        )
        flush(DEFAULT_TIMEOUT)
    except Exception:
        logger.debug("could not report an uncaught exception", exc_info=True)


# Both hooks report, flush, then hand over to the hook that was there before,
# which prints the traceback as Python always does.
def _install_excepthooks() -> Callable[[], None]:
    previous_excepthook = sys.excepthook
    previous_thread_hook = threading.excepthook

    def excepthook(
        error_type: Type[BaseException], error: BaseException, tb: Optional[TracebackType]
    ) -> None:
        if not issubclass(error_type, KeyboardInterrupt):
            _capture_uncaught(error_type, error, tb)
        previous_excepthook(error_type, error, tb)

    def thread_excepthook(args: Any) -> None:
        if args.exc_value is not None and not issubclass(args.exc_type, SystemExit):
            _capture_uncaught(args.exc_type, args.exc_value, args.exc_traceback)
        previous_thread_hook(args)

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook

    def restore() -> None:
        if sys.excepthook is excepthook:
            sys.excepthook = previous_excepthook
        if threading.excepthook is thread_excepthook:
            threading.excepthook = previous_thread_hook

    return restore


def _install_logging_handler(provider: LoggerProvider, level: int) -> Callable[[], None]:
    handler = InstatusLoggingHandler(provider, level)
    root = logging.getLogger()
    root.addHandler(handler)
    return lambda: root.removeHandler(handler)


def _instrument(
    instrumentations: Iterable[Instrumentor],
    tracer_provider: TracerProvider,
    meter_provider: Optional[MeterProvider],
) -> Callable[[], None]:
    instrumented = list(instrumentations)
    for instrumentor in instrumented:
        instrumentor.instrument(tracer_provider=tracer_provider, meter_provider=meter_provider)

    def uninstrument() -> None:
        for instrumentor in instrumented:
            instrumentor.uninstrument()

    return uninstrument


_exit_hook_registered = False


def _register_exit_hook() -> None:
    global _exit_hook_registered
    if not _exit_hook_registered:
        atexit.register(close, DEFAULT_TIMEOUT)
        _exit_hook_registered = True


def init(
    api_key: Optional[str] = None,
    site_id: Optional[str] = None,
    service_name: Optional[str] = None,
    release: Optional[str] = None,
    environment: Optional[str] = None,
    endpoint: Optional[str] = None,
    traces_sample_rate: float = 1.0,
    before_send: Optional[BeforeSend] = None,
    max_events_per_minute: int = DEFAULT_MAX_EVENTS_PER_MINUTE,
    logging_level: int = logging.INFO,
    instrumentations: Iterable[Instrumentor] = (),
    enabled: bool = True,
) -> None:
    with state.lock:
        if state.runtime is not None:
            return
        # Disabled, the providers still exist so start_span and context work,
        # but nothing is exported and no hook or instrumentation is installed.
        exports = resolve_exports(api_key, site_id, endpoint, os.environ) if enabled else {}
        if enabled and "logs" not in exports:
            logger.warning(
                "init needs an api_key (or INSTATUS_API_KEY) or an OTLP endpoint; nothing is sent"
            )
        resource = build_resource(service_name, release, environment)
        logger_provider = _logger_provider(resource, exports.get("logs"))
        tracer_provider = _tracer_provider(resource, exports.get("traces"), traces_sample_rate)
        metrics_target = exports.get("metrics")
        meter_provider = _meter_provider(resource, metrics_target) if metrics_target else None
        client = Client(
            emit=_emitter(logger_provider),
            rate_cap=RateCap(max_events_per_minute, _MINUTE),
            release=release,
            environment=environment,
            before_send=before_send,
            enabled=enabled,
        )
        runtime = state.Runtime(client, logger_provider, tracer_provider, meter_provider)
        _set_globals(runtime)
        if enabled:
            runtime.cleanups.append(_install_excepthooks())
            if "logs" in exports:
                runtime.cleanups.append(_install_logging_handler(logger_provider, logging_level))
            runtime.cleanups.append(_instrument(instrumentations, tracer_provider, meter_provider))
        state.runtime = runtime
        _register_exit_hook()


def _remaining_ms(deadline: float) -> int:
    return max(0, int((deadline - time.monotonic()) * 1000))


def _flush_runtime(runtime: state.Runtime, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    try:
        flushed = runtime.tracer_provider.force_flush(_remaining_ms(deadline))
        flushed = runtime.logger_provider.force_flush(_remaining_ms(deadline)) and flushed
        if runtime.meter_provider is not None:
            flushed = runtime.meter_provider.force_flush(_remaining_ms(deadline)) and flushed
    except Exception:
        logger.debug("flush failed", exc_info=True)
        return False
    return bool(flushed)


def flush(timeout: float = DEFAULT_TIMEOUT) -> bool:
    runtime = state.runtime
    if runtime is None:
        return True
    return _flush_runtime(runtime, timeout)


def _shutdown(runtime: state.Runtime) -> None:
    runtime.tracer_provider.shutdown()
    runtime.logger_provider.shutdown()
    if runtime.meter_provider is not None:
        runtime.meter_provider.shutdown()


def _run_cleanups(runtime: state.Runtime) -> None:
    for cleanup in reversed(runtime.cleanups):
        try:
            cleanup()
        except Exception:
            logger.debug("cleanup failed", exc_info=True)


# The providers' shutdown takes no deadline, so it runs on a daemon thread
# that the process does not wait for once the timeout passes.
def close(timeout: float = DEFAULT_TIMEOUT) -> bool:
    with state.lock:
        runtime = state.runtime
        if runtime is None:
            return True
        state.runtime = None
    _run_cleanups(runtime)
    deadline = time.monotonic() + timeout
    flushed = _flush_runtime(runtime, timeout)
    worker = threading.Thread(target=_shutdown, args=(runtime,), daemon=True)
    worker.start()
    worker.join(max(0.0, deadline - time.monotonic()))
    return flushed and not worker.is_alive()
