from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Mapping, NamedTuple, Optional, Union

from .event import Event
from .scrub import scrub_text, scrub_value

AttributeValue = Union[str, bool, int, float]
Attributes = Dict[str, AttributeValue]


class Severity(NamedTuple):
    number: int
    text: str


SEVERITY: Dict[str, Severity] = {
    "fatal": Severity(21, "FATAL"),
    "error": Severity(17, "ERROR"),
    "warning": Severity(13, "WARN"),
    "log": Severity(9, "INFO"),
    "info": Severity(9, "INFO"),
    "debug": Severity(5, "DEBUG"),
}

RESERVED_PREFIX = "instatus."
MAX_VALUE_LENGTH = 8192
MAX_STACK_LENGTH = 32_000
DEFAULT_EXCEPTION_TYPE = "Error"
_INT64_MIN, _INT64_MAX = -(2**63), 2**63 - 1
_USER_KEYS = {"username": "name", "ip_address": "ip"}


@dataclass(frozen=True)
class ErrorLogRecord:
    timestamp_ns: int
    severity_number: int
    severity_text: str
    body: str
    attributes: Attributes


def _stringify(value: Any) -> str:
    try:
        return json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def to_attribute_value(value: Any) -> Optional[AttributeValue]:
    if value is None:
        return None
    if isinstance(value, str):
        return value[:MAX_VALUE_LENGTH]
    if isinstance(value, bool) or isinstance(value, float):
        return value
    if isinstance(value, int):
        return value if _INT64_MIN <= value <= _INT64_MAX else str(value)
    return _stringify(value)[:MAX_VALUE_LENGTH]


def put(attributes: Attributes, key: str, value: Any) -> None:
    if key.startswith(RESERVED_PREFIX):
        return
    attribute = to_attribute_value(scrub_value(key, value))
    if attribute is not None and attribute != "":
        attributes[key] = attribute


# Python prints the most recent call last, so a long stack keeps its end.
def cut_stack(stack: str) -> str:
    return scrub_text(stack)[-MAX_STACK_LENGTH:]


def cut_text(text: str) -> str:
    return scrub_text(text)[:MAX_VALUE_LENGTH]


def _user_attributes(user: Optional[Mapping[str, Any]]) -> Attributes:
    attributes: Attributes = {}
    if not user:
        return attributes
    end_user = next(
        (user[key] for key in ("id", "email", "username") if user.get(key) not in (None, "")),
        None,
    )
    if end_user is not None:
        attributes["enduser.id"] = str(end_user)
    for key, value in user.items():
        put(attributes, f"user.{_USER_KEYS.get(key, key)}", value)
    return attributes


def _metadata(event: Event) -> Attributes:
    metadata: Attributes = {}
    for key, value in event["tags"].items():
        put(metadata, str(key), value)
    for name, context in event["contexts"].items():
        if not isinstance(context, Mapping):
            put(metadata, str(name), context)
            continue
        for key, value in context.items():
            put(metadata, f"{name}.{key}", value)
    for key, value in event["extra"].items():
        put(metadata, f"extra.{key}", value)
    return {**metadata, **_user_attributes(event.get("user"))}


def _headline(error_type: str, message: str) -> str:
    return f"{error_type}: {message}" if message else error_type


def _exception_attributes(event: Event, is_error: bool) -> Attributes:
    attributes: Attributes = {}
    values = event.get("exception", {}).get("values") or []
    if values:
        exception = values[0]
        attributes["exception.type"] = exception.get("type") or DEFAULT_EXCEPTION_TYPE
        attributes["exception.message"] = cut_text(exception.get("value") or "")
        stacktrace = exception.get("stacktrace")
        if stacktrace:
            attributes["exception.stacktrace"] = cut_stack(stacktrace)
        mechanism = exception.get("mechanism")
        if mechanism is not None:
            attributes["exception.handled"] = mechanism["handled"]
        return attributes
    message = event.get("message")
    if is_error and message:
        attributes["exception.type"] = DEFAULT_EXCEPTION_TYPE
        attributes["exception.message"] = cut_text(message)
    return attributes


def _body(event: Event) -> str:
    values = event.get("exception", {}).get("values") or []
    if values:
        exception = values[0]
        error_type = exception.get("type") or DEFAULT_EXCEPTION_TYPE
        return _headline(error_type, scrub_text(exception.get("value") or ""))
    return scrub_text(event.get("message") or "")


def severity_of(level: str) -> Severity:
    return SEVERITY.get(level, SEVERITY["error"])


# Sentry tags, contexts and extras become log attributes, and errors follow
# the OpenTelemetry exception conventions so Instatus Errors groups them.
def event_to_log_record(event: Event) -> ErrorLogRecord:
    severity = severity_of(event["level"])
    is_error = severity.number >= SEVERITY["error"].number
    attributes: Attributes = {
        **_exception_attributes(event, is_error),
        "log.record.uid": event["event_id"],
    }
    # The error's own fields win: receivers cap attribute counts, and
    # metadata must never push the exception out.
    for key, value in _metadata(event).items():
        attributes.setdefault(key, value)
    return ErrorLogRecord(
        timestamp_ns=int(event["timestamp"] * 1e9),
        severity_number=severity.number,
        severity_text=severity.text,
        body=_body(event),
        attributes=attributes,
    )
