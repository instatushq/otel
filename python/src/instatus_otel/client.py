from __future__ import annotations

import logging
from typing import Callable, Dict, Optional

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode

from .attributes import ErrorLogRecord, event_to_log_record
from .dedupe import Dedupe, mark_captured, was_captured
from .event import Event, Hint
from .rate_cap import RateCap

BeforeSend = Callable[[Event, Hint], Optional[Event]]
Emit = Callable[[ErrorLogRecord], None]

logger = logging.getLogger("instatus_otel")

_SPAN_EVENT_KEYS = ("exception.type", "exception.message", "exception.stacktrace")


# The span event is what OpenTelemetry's own record_exception writes. It is
# built from the scrubbed record, so traces carry nothing the log doesn't.
def _record_on_span(span: Span, event: Event, record: ErrorLogRecord) -> None:
    values = event.get("exception", {}).get("values") or []
    if not values or not span.is_recording():
        return
    attributes: Dict[str, str] = {
        key: str(record.attributes[key]) for key in _SPAN_EVENT_KEYS if key in record.attributes
    }
    span.add_event("exception", attributes)
    if values[0].get("mechanism", {}).get("handled") is False:
        span.set_status(Status(StatusCode.ERROR, attributes.get("exception.message")))


class Client:
    def __init__(
        self,
        *,
        emit: Emit,
        rate_cap: RateCap,
        release: Optional[str] = None,
        environment: Optional[str] = None,
        before_send: Optional[BeforeSend] = None,
        enabled: bool = True,
    ) -> None:
        self._emit = emit
        self._rate_cap = rate_cap
        self._release = release
        self._environment = environment
        self._before_send = before_send
        self._enabled = enabled
        self._dedupe = Dedupe()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _prepare(self, event: Event) -> Event:
        prepared: Event = {**event}
        if self._release and "release" not in prepared:
            prepared["release"] = self._release
        if self._environment and "environment" not in prepared:
            prepared["environment"] = self._environment
        return prepared

    def _send(self, event: Event, span: Span) -> None:
        if self._dedupe.is_duplicate(event):
            logger.debug("dropped a duplicate event")
            return
        if not self._rate_cap.take():
            logger.debug("rate cap reached")
            return
        record = event_to_log_record(event)
        _record_on_span(span, event, record)
        self._emit(record)

    # Reporting must never raise into an app that is already handling an error.
    def capture_event(self, event: Event, hint: Optional[Hint] = None) -> str:
        hint = hint or {}
        exc_info = hint.get("exc_info")
        error = exc_info[1] if exc_info else None
        if not self._enabled or was_captured(error):
            return event["event_id"]
        mark_captured(error)
        span = trace.get_current_span()
        try:
            prepared = self._prepare(event)
            kept = self._before_send(prepared, hint) if self._before_send else prepared
        except Exception:
            logger.debug("before_send raised", exc_info=True)
            return event["event_id"]
        if kept is None:
            logger.debug("before_send dropped an event")
            return event["event_id"]
        try:
            self._send(kept, span)
        except Exception:
            logger.debug("could not send an event", exc_info=True)
        return event["event_id"]
