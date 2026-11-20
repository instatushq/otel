from __future__ import annotations

import threading
from typing import Optional

from .event import Event

_MARKER = "__instatus_captured__"


def _signature(event: Event) -> str:
    values = event.get("exception", {}).get("values") or []
    if values:
        exception = values[0]
        return "|".join(
            (exception.get("type", ""), exception.get("value", ""), exception.get("stacktrace", ""))
        )
    return f"message|{event.get('message', '')}"


# Same as Sentry's Dedupe integration: an event identical to the one just
# sent is a re-raise, or a handler and a hook both reporting one error.
class Dedupe:
    def __init__(self) -> None:
        self._previous: Optional[str] = None
        self._lock = threading.Lock()

    def is_duplicate(self, event: Event) -> bool:
        signature = _signature(event)
        with self._lock:
            duplicate = signature == self._previous
            self._previous = signature
        return duplicate


def was_captured(error: Optional[BaseException]) -> bool:
    return error is not None and getattr(error, _MARKER, False) is True


def mark_captured(error: Optional[BaseException]) -> None:
    if error is None:
        return
    try:
        setattr(error, _MARKER, True)
    except (AttributeError, TypeError):
        return
