from __future__ import annotations

import logging
import sys
import threading

import pytest

import instatus_otel


def test_disabled_init_keeps_spans_and_sends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INSTATUS_API_KEY", "sk_test")
    excepthook, thread_hook = sys.excepthook, threading.excepthook
    root_handlers = list(logging.getLogger().handlers)
    instatus_otel.init(enabled=False)
    try:
        with instatus_otel.start_span("job") as span:
            assert span.get_span_context().is_valid
            assert instatus_otel.capture_message("quiet", "error") is not None
        assert sys.excepthook is excepthook
        assert threading.excepthook is thread_hook
        assert logging.getLogger().handlers == root_handlers
    finally:
        assert instatus_otel.close()


def test_init_without_a_key_warns(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    for name in ("INSTATUS_API_KEY", "OTEL_EXPORTER_OTLP_ENDPOINT"):
        monkeypatch.delenv(name, raising=False)
    instatus_otel.init()
    try:
        assert "init needs an api_key" in caplog.text
        assert instatus_otel.flush()
    finally:
        instatus_otel.close()


def test_close_restores_the_process() -> None:
    excepthook = sys.excepthook
    root_handlers = list(logging.getLogger().handlers)
    instatus_otel.init(endpoint="http://127.0.0.1:9")
    assert sys.excepthook is not excepthook
    assert len(logging.getLogger().handlers) == len(root_handlers) + 1
    instatus_otel.close(0.5)
    assert sys.excepthook is excepthook
    assert logging.getLogger().handlers == root_handlers
    assert instatus_otel.capture_message("after close") is None
