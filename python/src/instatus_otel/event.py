from __future__ import annotations

import sys
import time
import traceback
import uuid
from types import FrameType, TracebackType
from typing import Any, Dict, List, Literal, Optional, Tuple, Type, TypedDict, Union

Level = Literal["fatal", "error", "warning", "info", "log", "debug"]
ExcInfo = Tuple[Type[BaseException], BaseException, Optional[TracebackType]]
ErrorInput = Union[BaseException, ExcInfo, None]


class Mechanism(TypedDict):
    type: str
    handled: bool


class _ExceptionValueRequired(TypedDict):
    type: str
    value: str


class ExceptionValue(_ExceptionValueRequired, total=False):
    stacktrace: str
    mechanism: Mechanism


class ExceptionValues(TypedDict):
    values: List[ExceptionValue]


class _EventRequired(TypedDict):
    event_id: str
    timestamp: float
    level: Level
    tags: Dict[str, Any]
    extra: Dict[str, Any]
    contexts: Dict[str, Any]


class Event(_EventRequired, total=False):
    message: str
    exception: ExceptionValues
    user: Dict[str, Any]
    release: str
    environment: str


class Hint(TypedDict, total=False):
    exc_info: ExcInfo


_PACKAGE = __name__.rpartition(".")[0]


def generate_event_id() -> str:
    return uuid.uuid4().hex


def exception_type_name(error_type: type) -> str:
    module = getattr(error_type, "__module__", None)
    name = getattr(error_type, "__qualname__", error_type.__name__)
    if not isinstance(module, str) or module in ("__main__", "builtins"):
        return name
    return f"{module}.{name}"


def exception_message(error: BaseException) -> str:
    try:
        return str(error)
    except Exception:
        return "<exception str() failed>"


def _caller_frame() -> Optional[FrameType]:
    frame: Optional[FrameType] = sys._getframe(1)
    while frame is not None and str(frame.f_globals.get("__name__", "")).startswith(_PACKAGE):
        frame = frame.f_back
    return frame


# An exception that was never raised has no traceback, so it gets the stack
# of the code that captured it, in the form Python prints.
def format_stacktrace(error: BaseException) -> str:
    error_type = type(error)
    if error.__traceback__ is not None:
        return "".join(traceback.format_exception(error_type, error, error.__traceback__))
    lines = ["Traceback (most recent call last):\n"]
    lines.extend(traceback.format_list(traceback.extract_stack(_caller_frame())))
    lines.extend(traceback.format_exception_only(error_type, error))
    return "".join(lines)


def to_exc_info(error: ErrorInput) -> Optional[ExcInfo]:
    if error is None:
        current = sys.exc_info()
        if current[1] is None:
            return None
        return current
    if isinstance(error, BaseException):
        return type(error), error, error.__traceback__
    return error


def exception_value(error: BaseException, mechanism: Mechanism) -> ExceptionValue:
    return {
        "type": exception_type_name(type(error)),
        "value": exception_message(error),
        "stacktrace": format_stacktrace(error),
        "mechanism": mechanism,
    }


def _empty_event(level: Level) -> Event:
    return {
        "event_id": generate_event_id(),
        "timestamp": time.time(),
        "level": level,
        "tags": {},
        "extra": {},
        "contexts": {},
    }


def event_from_exception(error: BaseException, mechanism: Mechanism) -> Event:
    event = _empty_event("error")
    event["exception"] = {"values": [exception_value(error, mechanism)]}
    return event


def event_from_message(message: str, level: Level) -> Event:
    event = _empty_event(level)
    event["message"] = message
    return event
