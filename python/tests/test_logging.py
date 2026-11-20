from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Iterator, Tuple

import pytest
from opentelemetry._logs import SeverityNumber

import instatus_otel
from instatus_otel import state
from instatus_otel.logging_handler import InstatusLoggingHandler
from instatus_otel.scrub import FILTERED

from .conftest import Harness, is_python_stack


@pytest.fixture
def app_logger(harness: Harness) -> Iterator[Tuple[logging.Logger, Harness]]:
    assert state.runtime is not None
    handler = InstatusLoggingHandler(state.runtime.logger_provider, logging.INFO)
    logger = logging.getLogger("tests.app")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    logger.addHandler(handler)
    yield logger, harness
    logger.removeHandler(handler)


def exported(harness: Harness) -> Any:
    return [item.log_record for item in harness.logs.get_finished_logs()]


def test_records_reach_logs(app_logger: Tuple[logging.Logger, Harness]) -> None:
    logger, harness = app_logger
    logger.info("Order %s placed", 1042, extra={"order_id": 1042, "password": "x"})
    logger.debug("below the level")
    (record,) = exported(harness)
    assert record.body == "Order 1042 placed"
    assert record.severity_number is SeverityNumber.INFO
    assert record.severity_text == "INFO"
    assert record.attributes["order_id"] == 1042
    assert record.attributes["password"] == FILTERED
    assert record.attributes["code.function.name"] == "test_records_reach_logs"
    assert "exception.type" not in record.attributes


def test_warning_and_critical_texts(app_logger: Tuple[logging.Logger, Harness]) -> None:
    logger, harness = app_logger
    logger.warning("careful")
    logger.critical("down")
    texts = [(record.severity_number, record.severity_text) for record in exported(harness)]
    assert texts == [(SeverityNumber.WARN, "WARN"), (SeverityNumber.FATAL, "FATAL")]


def test_card_numbers_are_filtered(app_logger: Tuple[logging.Logger, Harness]) -> None:
    logger, harness = app_logger
    logger.warning("card 4111 1111 1111 1111 declined")
    assert exported(harness)[0].body == f"card {FILTERED} declined"


def test_logged_exceptions_carry_the_traceback(app_logger: Tuple[logging.Logger, Harness]) -> None:
    logger, harness = app_logger
    prices: Dict[str, int] = {}
    try:
        prices["missing"]
    except KeyError:
        logger.exception("Lookup failed")
    attributes = exported(harness)[0].attributes
    assert attributes["exception.type"] == "KeyError"
    assert attributes["exception.message"] == "'missing'"
    assert is_python_stack(attributes["exception.stacktrace"])


def test_records_carry_the_active_span(app_logger: Tuple[logging.Logger, Harness]) -> None:
    logger, harness = app_logger
    with instatus_otel.start_span("request") as span:
        logger.info("inside")
    record = exported(harness)[0]
    assert record.trace_id == span.get_span_context().trace_id
    assert record.span_id == span.get_span_context().span_id


@pytest.mark.parametrize("name", ["opentelemetry.sdk._logs", "instatus_otel"])
def test_sdk_loggers_are_skipped(app_logger: Tuple[logging.Logger, Harness], name: str) -> None:
    logger, harness = app_logger
    handler = logger.handlers[0]
    handler.handle(logging.LogRecord(name, logging.ERROR, __file__, 1, "export failed", (), None))
    assert exported(harness) == []


def test_exporter_threads_are_skipped(app_logger: Tuple[logging.Logger, Harness]) -> None:
    logger, harness = app_logger
    thread = threading.Thread(
        target=logger.warning, args=("retrying",), name="OtelBatchLogRecordProcessor"
    )
    thread.start()
    thread.join()
    assert exported(harness) == []
