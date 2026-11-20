from __future__ import annotations

from typing import Any, Dict, List

import pytest

from instatus_otel.scrub import (
    FILTERED,
    is_sensitive_key,
    scrub_text,
    scrub_url,
    scrub_value,
)


@pytest.mark.parametrize(
    "key",
    [
        "password",
        "passwd",
        "db_pass",
        "client_secret",
        "access_token",
        "api_key",
        "X-Api-Key",
        "api.key",
        "Authorization",
        "credentials",
        "sessionid",
        "Cookie",
        "csrf",
        "XSRF-TOKEN",
        "private_key",
        "signature",
    ],
)
def test_sensitive_keys(key: str) -> None:
    assert is_sensitive_key(key)


@pytest.mark.parametrize("key", ["email", "plan", "order_id", "user_agent", "path"])
def test_plain_keys(key: str) -> None:
    assert not is_sensitive_key(key)


@pytest.mark.parametrize(
    "text",
    [
        "card 4111111111111111 declined",
        "card 4111 1111 1111 1111 declined",
        "card 4111-1111-1111-1111 declined",
        "card 5555555555554444 declined",
        "card 378282246310005 declined",
    ],
)
def test_card_numbers_are_filtered(text: str) -> None:
    assert scrub_text(text) == f"card {FILTERED} declined"


@pytest.mark.parametrize(
    "text",
    [
        "card 4111111111111112 declined",
        "at 1700000000000 ms",
        "order 1234567890123",
        "id 123456789012",
    ],
)
def test_numbers_failing_luhn_are_kept(text: str) -> None:
    assert scrub_text(text) == text


def test_url_credentials_are_removed() -> None:
    assert scrub_url("postgres://admin:hunter2@db.internal:5432/app") == (
        "postgres://db.internal:5432/app"
    )


def test_sensitive_url_params_are_filtered() -> None:
    url = "https://shop.test/cb?page=2&token=abc&api%5Fkey=xyz#access_token=def&state=ok"
    assert scrub_url(url) == (
        f"https://shop.test/cb?page=2&token={FILTERED}&api%5Fkey={FILTERED}"
        f"#access_token={FILTERED}&state=ok"
    )


def test_card_numbers_in_any_url_param_are_filtered() -> None:
    assert scrub_url("https://shop.test/pay?number=4111111111111111") == (
        f"https://shop.test/pay?number={FILTERED}"
    )


def test_nested_values() -> None:
    value = {
        "request": {"headers": {"Authorization": "Bearer abc", "accept": "json"}},
        "items": [{"card": "4111 1111 1111 1111"}, {"password": "x"}],
        "callback": "https://me:pw@hooks.test/?secret=1",
    }
    assert scrub_value("payload", value) == {
        "request": {"headers": {"Authorization": FILTERED, "accept": "json"}},
        "items": [{"card": FILTERED}, {"password": FILTERED}],
        "callback": f"https://hooks.test/?secret={FILTERED}",
    }


def test_sensitive_key_filters_the_whole_value() -> None:
    assert scrub_value("session", {"id": 1}) == FILTERED


def test_depth_is_capped() -> None:
    value: Dict[str, Any] = {}
    current = value
    for _ in range(10):
        current["child"] = {}
        current = current["child"]
    scrubbed = scrub_value("root", value)
    for _ in range(6):
        scrubbed = scrubbed["child"]
    assert scrubbed == "[Truncated]"


def test_cycles_are_cut() -> None:
    value: Dict[str, Any] = {"name": "loop"}
    value["self"] = value
    items: List[Any] = [1]
    items.append(items)
    assert scrub_value("root", value) == {"name": "loop", "self": "[Circular]"}
    assert scrub_value("root", items) == [1, "[Circular]"]


def test_shared_values_are_kept() -> None:
    address = {"city": "Lyon"}
    assert scrub_value("order", {"billing": address, "shipping": address}) == {
        "billing": {"city": "Lyon"},
        "shipping": {"city": "Lyon"},
    }


def test_other_objects_pass_through() -> None:
    marker = object()
    assert scrub_value("thing", marker) is marker
    assert scrub_value("count", 3) == 3
