from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Dict, Iterator, Mapping, Optional

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode, Tracer

from . import state
from .event import (
    ErrorInput,
    ExcInfo,
    Level,
    Mechanism,
    event_from_exception,
    event_from_message,
    exception_message,
    to_exc_info,
)
from .scope import Scope, get_current_scope, update_current_scope
from .scrub import scrub_text
from .version import SDK_NAME, __version__


def _scope_for(
    user: Optional[Mapping[str, Any]],
    level: Optional[Level],
    tags: Optional[Mapping[str, Any]],
    extras: Optional[Mapping[str, Any]],
    contexts: Optional[Mapping[str, Optional[Mapping[str, Any]]]],
) -> Scope:
    scope = get_current_scope()
    if not (user or level or tags or extras or contexts):
        return scope
    return scope.clone().update(
        user=user, level=level, tags=tags, extras=extras, contexts=contexts
    )


def capture_error(
    exc_info: ExcInfo,
    mechanism: Mechanism,
    *,
    user: Optional[Mapping[str, Any]] = None,
    level: Optional[Level] = None,
    tags: Optional[Mapping[str, Any]] = None,
    extras: Optional[Mapping[str, Any]] = None,
    contexts: Optional[Mapping[str, Optional[Mapping[str, Any]]]] = None,
) -> Optional[str]:
    runtime = state.runtime
    if runtime is None:
        return None
    event = event_from_exception(exc_info[1], mechanism)
    scope = _scope_for(user, level, tags, extras, contexts)
    return runtime.client.capture_event(scope.apply(event), {"exc_info": exc_info})


def capture_exception(
    error: ErrorInput = None,
    *,
    user: Optional[Mapping[str, Any]] = None,
    level: Optional[Level] = None,
    tags: Optional[Mapping[str, Any]] = None,
    extras: Optional[Mapping[str, Any]] = None,
    contexts: Optional[Mapping[str, Optional[Mapping[str, Any]]]] = None,
) -> Optional[str]:
    exc_info = to_exc_info(error)
    if exc_info is None:
        return None
    return capture_error(
        exc_info,
        {"type": "generic", "handled": True},
        user=user,
        level=level,
        tags=tags,
        extras=extras,
        contexts=contexts,
    )


def capture_message(
    message: str,
    level: Level = "info",
    *,
    user: Optional[Mapping[str, Any]] = None,
    tags: Optional[Mapping[str, Any]] = None,
    extras: Optional[Mapping[str, Any]] = None,
    contexts: Optional[Mapping[str, Optional[Mapping[str, Any]]]] = None,
) -> Optional[str]:
    runtime = state.runtime
    if runtime is None:
        return None
    event = event_from_message(message, level)
    scope = _scope_for(user, None, tags, extras, contexts)
    return runtime.client.capture_event(scope.apply(event))


def _end_user_id(user: Optional[Mapping[str, Any]]) -> Optional[str]:
    if not user:
        return None
    for key in ("id", "email", "username"):
        value = user.get(key)
        if value not in (None, ""):
            return str(value)
    return None


def set_user(user: Optional[Mapping[str, Any]]) -> None:
    update_current_scope(lambda scope: scope.set_user(user))
    end_user = _end_user_id(user)
    span = trace.get_current_span()
    if end_user is not None and span.is_recording():
        span.set_attribute("enduser.id", end_user)


def set_tag(key: str, value: Any) -> None:
    update_current_scope(lambda scope: scope.set_tag(key, value))


def set_tags(tags: Mapping[str, Any]) -> None:
    update_current_scope(lambda scope: scope.set_tags(tags))


def set_context(name: str, value: Optional[Mapping[str, Any]]) -> None:
    update_current_scope(lambda scope: scope.set_context(name, value))


def set_extra(key: str, value: Any) -> None:
    update_current_scope(lambda scope: scope.set_extra(key, value))


def set_extras(extras: Mapping[str, Any]) -> None:
    update_current_scope(lambda scope: scope.set_extras(extras))


def _tracer() -> Tracer:
    runtime = state.runtime
    if runtime is None:
        return trace.get_tracer(SDK_NAME, __version__)
    return runtime.tracer_provider.get_tracer(SDK_NAME, __version__)


# OpenTelemetry's own exception event would carry the unfiltered message and
# stack, so a failed span gets only a filtered status message.
@contextmanager
def start_span(
    name: str, *, op: Optional[str] = None, attributes: Optional[Mapping[str, Any]] = None
) -> Iterator[Span]:
    span_attributes: Dict[str, Any] = dict(attributes or {})
    if op:
        span_attributes["sentry.op"] = op
    with _tracer().start_as_current_span(
        name,
        attributes=span_attributes,
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        try:
            yield span
        except Exception as error:
            span.set_status(Status(StatusCode.ERROR, scrub_text(exception_message(error))))
            raise
