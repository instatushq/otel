from __future__ import annotations

from typing import Any, List, Optional

from opentelemetry.trace import StatusCode

import instatus_otel
from instatus_otel.event import Event, Hint
from instatus_otel.rate_cap import RateCap

from .conftest import Harness


def fail(message: str) -> None:
    raise RuntimeError(message)


def capture(message: str) -> Optional[str]:
    try:
        fail(message)
    except RuntimeError as error:
        return instatus_otel.capture_exception(error)
    return None


def test_capture_returns_the_event_id(harness: Harness) -> None:
    event_id = capture("boom")
    assert event_id == harness.records[0].attributes["log.record.uid"]


def test_capture_without_an_argument_uses_the_handled_exception(harness: Harness) -> None:
    try:
        fail("inside except")
    except RuntimeError:
        instatus_otel.capture_exception()
    assert harness.records[0].attributes["exception.message"] == "inside except"
    assert instatus_otel.capture_exception() is None


def test_without_init_nothing_is_sent() -> None:
    assert capture("boom") is None
    assert instatus_otel.capture_message("hi") is None


def test_identical_errors_in_a_row_are_sent_once(harness: Harness) -> None:
    for _ in range(2):
        capture("same")
    capture("other")
    capture("same")
    assert [record.attributes["exception.message"] for record in harness.records] == [
        "same",
        "other",
        "same",
    ]


def test_an_exception_is_reported_once(harness: Harness) -> None:
    error = ValueError("once")
    instatus_otel.capture_exception(error)
    instatus_otel.capture_message("between")
    instatus_otel.capture_exception(error)
    assert len(harness.records) == 2


def test_rate_cap(harness: Harness) -> None:
    clock = [0.0]
    harness.use_client(rate_cap=RateCap(2, 60, now=lambda: clock[0]))
    for index in range(5):
        instatus_otel.capture_message(f"message {index}", "error")
    assert len(harness.records) == 2
    clock[0] = 61
    instatus_otel.capture_message("after the window", "error")
    assert len(harness.records) == 3


def test_before_send_changes_events(harness: Harness) -> None:
    seen: List[Hint] = []

    def before_send(event: Event, hint: Hint) -> Optional[Event]:
        seen.append(hint)
        event["tags"]["edited"] = True
        return event

    harness.use_client(before_send=before_send, release="api@1", environment="prod")
    capture("boom")
    assert harness.records[0].attributes["edited"] is True
    exc_info = seen[0].get("exc_info")
    assert exc_info is not None and isinstance(exc_info[1], RuntimeError)


def test_before_send_sees_release_and_traceback(harness: Harness) -> None:
    events: List[Event] = []

    def before_send(event: Event, hint: Hint) -> Optional[Event]:
        events.append(event)
        return event

    harness.use_client(before_send=before_send, release="api@1", environment="prod")
    capture("boom")
    event = events[0]
    assert (event["release"], event["environment"]) == ("api@1", "prod")
    stack = event["exception"]["values"][0]["stacktrace"]
    assert stack.startswith("Traceback (most recent call last):")


def test_before_send_can_drop(harness: Harness) -> None:
    harness.use_client(before_send=lambda event, hint: None)
    capture("dropped")
    assert harness.records == []


def test_before_send_errors_never_reach_the_app(harness: Harness) -> None:
    def before_send(event: Event, hint: Hint) -> Optional[Event]:
        raise KeyError("bug in before_send")

    harness.use_client(before_send=before_send)
    assert capture("boom") is not None
    assert harness.records == []


def test_disabled_client_sends_nothing(harness: Harness) -> None:
    harness.use_client(enabled=False)
    capture("boom")
    assert harness.records == []


def test_capture_scope_arguments(harness: Harness) -> None:
    instatus_otel.set_tag("plan", "free")
    try:
        fail("boom")
    except RuntimeError as error:
        instatus_otel.capture_exception(
            error,
            tags={"plan": "pro"},
            extras={"retry": 2},
            user={"id": "u1"},
            contexts={"cart": {"items": 3}},
            level="warning",
        )
    attributes = harness.records[0].attributes
    assert attributes["plan"] == "pro"
    assert attributes["extra.retry"] == 2
    assert attributes["enduser.id"] == "u1"
    assert attributes["cart.items"] == 3
    assert harness.records[0].severity_text == "WARN"
    assert instatus_otel.get_global_scope().tags == {"plan": "free"}


def test_errors_inside_a_span_go_on_the_span(harness: Harness) -> None:
    with instatus_otel.start_span("charge", op="job", attributes={"order.id": 7}):
        capture("card 4111111111111111 declined")
    span = harness.spans.get_finished_spans()[0]
    assert span.name == "charge"
    assert span.attributes is not None
    assert span.attributes["sentry.op"] == "job"
    assert span.attributes["order.id"] == 7
    assert span.status.status_code is StatusCode.UNSET
    event = span.events[0]
    assert event.name == "exception"
    assert event.attributes is not None
    assert event.attributes["exception.message"] == "card [Filtered] declined"
    assert "4111" not in str(event.attributes["exception.stacktrace"])


def test_unhandled_errors_fail_the_span(harness: Harness) -> None:
    from instatus_otel.api import capture_error

    with instatus_otel.start_span("job"):
        error = RuntimeError("crash")
        capture_error((RuntimeError, error, None), {"type": "excepthook", "handled": False})
    assert harness.spans.get_finished_spans()[0].status.status_code is StatusCode.ERROR


def test_start_span_marks_failures_and_reraises(harness: Harness) -> None:
    raised: Any = None
    try:
        with instatus_otel.start_span("charge"):
            fail("card 4111111111111111 declined")
    except RuntimeError as error:
        raised = error
    assert raised is not None
    span = harness.spans.get_finished_spans()[0]
    assert span.status.status_code is StatusCode.ERROR
    assert span.status.description == "card [Filtered] declined"
    assert span.events == ()


def test_set_user_marks_the_active_span(harness: Harness) -> None:
    with instatus_otel.start_span("request"):
        instatus_otel.set_user({"email": "ada@example.com"})
    span = harness.spans.get_finished_spans()[0]
    assert span.attributes is not None
    assert span.attributes["enduser.id"] == "ada@example.com"
