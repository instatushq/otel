from __future__ import annotations

import logging
import threading
import time
from typing import Dict

from opentelemetry import context
from opentelemetry._logs import Logger, LoggerProvider, LogRecord, SeverityNumber

from .attributes import Attributes, cut_stack, cut_text, put
from .event import exception_message, exception_type_name, format_stacktrace
from .scrub import scrub_text

# The SDK's own warnings, and anything logged while the exporters send, would
# otherwise feed back into the export they describe.
_SKIPPED_LOGGERS = ("opentelemetry", "instatus_otel")
_EXPORTER_THREAD_PREFIX = "Otel"

_RESERVED = frozenset(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {
    "message",
    "asctime",
    "taskName",
}


def _severity(levelno: int) -> SeverityNumber:
    if levelno >= logging.CRITICAL:
        return SeverityNumber.FATAL
    if levelno >= logging.ERROR:
        return SeverityNumber.ERROR
    if levelno >= logging.WARNING:
        return SeverityNumber.WARN
    if levelno >= logging.INFO:
        return SeverityNumber.INFO
    if levelno >= logging.DEBUG:
        return SeverityNumber.DEBUG
    return SeverityNumber.TRACE


def _severity_text(levelname: str) -> str:
    return {"WARNING": "WARN", "CRITICAL": "FATAL"}.get(levelname, levelname)


def _is_skipped(record: logging.LogRecord) -> bool:
    if record.name.split(".", 1)[0] in _SKIPPED_LOGGERS:
        return True
    return threading.current_thread().name.startswith(_EXPORTER_THREAD_PREFIX)


def _attributes(record: logging.LogRecord) -> Attributes:
    attributes: Attributes = {
        "code.file.path": record.pathname,
        "code.function.name": record.funcName,
        "code.line.number": record.lineno,
    }
    for key, value in vars(record).items():
        if key not in _RESERVED:
            put(attributes, key, value)
    if record.exc_info and record.exc_info[1] is not None:
        error = record.exc_info[1]
        attributes["exception.type"] = exception_type_name(type(error))
        attributes["exception.message"] = cut_text(exception_message(error))
        attributes["exception.stacktrace"] = cut_stack(format_stacktrace(error))
    return attributes


class InstatusLoggingHandler(logging.Handler):
    def __init__(self, logger_provider: LoggerProvider, level: int = logging.NOTSET) -> None:
        super().__init__(level)
        self._provider = logger_provider
        self._loggers: Dict[str, Logger] = {}
        self._emitting = threading.local()

    def _logger_for(self, name: str) -> Logger:
        logger = self._loggers.get(name)
        if logger is None:
            logger = self._provider.get_logger(name)
            self._loggers[name] = logger
        return logger

    def emit(self, record: logging.LogRecord) -> None:
        if _is_skipped(record) or getattr(self._emitting, "active", False):
            return
        self._emitting.active = True
        try:
            body = self.format(record) if self.formatter else record.getMessage()
            self._logger_for(record.name).emit(
                LogRecord(
                    timestamp=int(record.created * 1e9),
                    observed_timestamp=time.time_ns(),
                    context=context.get_current(),
                    severity_number=_severity(record.levelno),
                    severity_text=_severity_text(record.levelname),
                    body=scrub_text(body),
                    attributes=_attributes(record),
                )
            )
        except Exception:
            self.handleError(record)
        finally:
            self._emitting.active = False
