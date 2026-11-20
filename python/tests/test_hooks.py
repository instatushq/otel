from __future__ import annotations

import sys
import threading
from types import TracebackType
from typing import Any, List, Optional, Tuple, Type

import pytest

from instatus_otel.sdk import _install_excepthooks

from .conftest import Harness, is_python_stack

ExcInfo = Tuple[Type[BaseException], BaseException, Optional[TracebackType]]


def crash() -> None:
    raise RuntimeError("worker crashed")


def test_uncaught_exceptions_are_reported_then_printed(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    printed: List[ExcInfo] = []
    monkeypatch.setattr(sys, "excepthook", lambda *exc_info: printed.append(exc_info))
    previous = sys.excepthook
    restore = _install_excepthooks()
    try:
        crash()
    except RuntimeError:
        exc_info = sys.exc_info()
    sys.excepthook(*exc_info)
    restore()

    record = harness.records[0]
    assert record.severity_text == "FATAL"
    assert record.attributes["exception.handled"] is False
    assert record.attributes["exception.type"] == "RuntimeError"
    assert is_python_stack(str(record.attributes["exception.stacktrace"]))
    assert printed and printed[0][1] is exc_info[1]
    assert sys.excepthook is previous


def test_keyboard_interrupt_is_not_reported(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    printed: List[ExcInfo] = []
    monkeypatch.setattr(sys, "excepthook", lambda *exc_info: printed.append(exc_info))
    restore = _install_excepthooks()
    error = KeyboardInterrupt()
    sys.excepthook(KeyboardInterrupt, error, None)
    restore()
    assert harness.records == []
    assert len(printed) == 1


def test_thread_exceptions_are_reported(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    printed: List[Any] = []
    monkeypatch.setattr(threading, "excepthook", printed.append)
    previous = threading.excepthook
    restore = _install_excepthooks()
    thread = threading.Thread(target=crash)
    thread.start()
    thread.join()
    restore()

    record = harness.records[0]
    assert record.attributes["exception.message"] == "worker crashed"
    assert record.attributes["exception.handled"] is False
    assert record.severity_text == "FATAL"
    assert printed[0].exc_type is RuntimeError
    assert threading.excepthook is previous
