from __future__ import annotations

import json
import re
from typing import Any

import pytest

from instatus_otel.attributes import MAX_STACK_LENGTH, MAX_VALUE_LENGTH, event_to_log_record
from instatus_otel.event import (
    Event,
    event_from_exception,
    event_from_message,
    exception_type_name,
)
from instatus_otel.scope import Scope
from instatus_otel.scrub import FILTERED

from .conftest import PYTHON_FRAME, is_python_stack


class PaymentError(Exception):
    pass


def charge() -> None:
    raise PaymentError("card 4111 1111 1111 1111 declined")


def raised_event(handled: bool = True) -> Event:
    try:
        charge()
    except PaymentError as error:
        return event_from_exception(error, {"type": "generic", "handled": handled})
    raise AssertionError("charge did not raise")


def test_exception_record() -> None:
    record = event_to_log_record(raised_event())
    attributes = record.attributes
    assert attributes["exception.type"] == f"{__name__}.PaymentError"
    assert attributes["exception.message"] == f"card {FILTERED} declined"
    assert attributes["exception.handled"] is True
    assert record.body == f"{__name__}.PaymentError: card {FILTERED} declined"
    assert record.severity_number == 17
    assert record.severity_text == "ERROR"
    assert re.fullmatch(r"[0-9a-f]{32}", str(attributes["log.record.uid"]))


def test_stacktrace_is_the_python_traceback() -> None:
    stack = str(event_to_log_record(raised_event()).attributes["exception.stacktrace"])
    assert stack.startswith("Traceback (most recent call last):\n")
    assert is_python_stack(stack)
    functions = [match.group(3) for match in PYTHON_FRAME.finditer(stack)]
    assert functions == ["raised_event", "charge"]
    assert stack.rstrip("\n").endswith(f"PaymentError: card {FILTERED} declined")
    assert "4111" not in stack


def test_unraised_exception_gets_the_capturing_stack() -> None:
    event = event_from_exception(ValueError("bad"), {"type": "generic", "handled": True})
    stack = str(event_to_log_record(event).attributes["exception.stacktrace"])
    assert is_python_stack(stack)
    assert "test_unraised_exception_gets_the_capturing_stack" in stack
    assert "instatus_otel" not in stack
    assert stack.endswith("ValueError: bad\n")


def test_unhandled_flag() -> None:
    assert event_to_log_record(raised_event(handled=False)).attributes["exception.handled"] is False


def test_exception_type_names() -> None:
    assert exception_type_name(ValueError) == "ValueError"
    assert exception_type_name(json.JSONDecodeError) == "json.decoder.JSONDecodeError"


def test_empty_message_body_is_the_type() -> None:
    event = event_from_exception(KeyError(), {"type": "generic", "handled": True})
    assert event_to_log_record(event).body == "KeyError"


@pytest.mark.parametrize(
    "level,number,text",
    [
        ("fatal", 21, "FATAL"),
        ("error", 17, "ERROR"),
        ("warning", 13, "WARN"),
        ("info", 9, "INFO"),
        ("log", 9, "INFO"),
        ("debug", 5, "DEBUG"),
    ],
)
def test_severity(level: Any, number: int, text: str) -> None:
    record = event_to_log_record(event_from_message("hello", level))
    assert (record.severity_number, record.severity_text) == (number, text)


def test_error_messages_are_issues() -> None:
    attributes = event_to_log_record(event_from_message("Webhook failed", "error")).attributes
    assert attributes["exception.type"] == "Error"
    assert attributes["exception.message"] == "Webhook failed"


def test_info_messages_are_plain_logs() -> None:
    record = event_to_log_record(event_from_message("Deployed", "info"))
    assert record.body == "Deployed"
    assert "exception.type" not in record.attributes


def test_scope_metadata() -> None:
    scope = Scope()
    scope.set_user({"id": 42, "email": "ada@example.com", "username": "ada", "ip_address": "1.2.3.4"})
    scope.set_tags({"plan": "pro", "instatus.internal": "x"})
    scope.set_context("cart", {"items": 3, "token": "abc"})
    scope.set_extra("retry", 2)
    scope.set_extra("payload", {"password": "x", "ok": True})
    attributes = event_to_log_record(scope.apply(event_from_message("hi", "info"))).attributes
    assert attributes["enduser.id"] == "42"
    assert attributes["user.id"] == 42
    assert attributes["user.email"] == "ada@example.com"
    assert attributes["user.name"] == "ada"
    assert attributes["user.ip"] == "1.2.3.4"
    assert attributes["plan"] == "pro"
    assert "instatus.internal" not in attributes
    assert attributes["cart.items"] == 3
    assert attributes["cart.token"] == FILTERED
    assert attributes["extra.retry"] == 2
    assert json.loads(str(attributes["extra.payload"])) == {"password": FILTERED, "ok": True}


def test_end_user_falls_back_to_email_then_username() -> None:
    scope = Scope().set_user({"email": "ada@example.com", "username": "ada"})
    record = event_to_log_record(scope.apply(event_from_message("hi", "info")))
    assert record.attributes["enduser.id"] == "ada@example.com"
    scope.set_user({"username": "ada"})
    record = event_to_log_record(scope.apply(event_from_message("hi", "info")))
    assert record.attributes["enduser.id"] == "ada"


def test_error_fields_win_over_metadata() -> None:
    scope = Scope().set_tags({"exception.type": "Spoofed", "log.record.uid": "x"})
    event = scope.apply(raised_event())
    attributes = event_to_log_record(event).attributes
    assert attributes["exception.type"] == f"{__name__}.PaymentError"
    assert attributes["log.record.uid"] == event["event_id"]


def test_long_values_are_cut() -> None:
    scope = Scope().set_tag("note", "x" * (MAX_VALUE_LENGTH + 10))
    attributes = event_to_log_record(scope.apply(event_from_message("hi", "info"))).attributes
    assert len(str(attributes["note"])) == MAX_VALUE_LENGTH


def test_long_stacks_keep_their_end() -> None:
    event = raised_event()
    exception = event["exception"]["values"][0]
    exception["stacktrace"] = "x" * MAX_STACK_LENGTH + exception["stacktrace"]
    stack = str(event_to_log_record(event).attributes["exception.stacktrace"])
    assert len(stack) == MAX_STACK_LENGTH
    assert stack.rstrip("\n").endswith(f"PaymentError: card {FILTERED} declined")


def test_values_that_are_not_attributes_become_json() -> None:
    scope = Scope().set_extras({"ids": [1, 2], "big": 2**70, "none": None, "empty": ""})
    attributes = event_to_log_record(scope.apply(event_from_message("hi", "info"))).attributes
    assert attributes["extra.ids"] == "[1, 2]"
    assert attributes["extra.big"] == str(2**70)
    assert "extra.none" not in attributes
    assert "extra.empty" not in attributes
