from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Set
from urllib.parse import unquote

FILTERED = "[Filtered]"
CIRCULAR = "[Circular]"
TRUNCATED = "[Truncated]"
MAX_DEPTH = 6

_SENSITIVE_KEY = re.compile(
    r"pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie"
    r"|csrf|xsrf|private[-_.]?key|signature",
    re.IGNORECASE,
)
_CARD_NUMBER = re.compile(r"\b\d(?:[ -]?\d){12,18}\b", re.ASCII)
_URL = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_URL_CREDENTIALS = re.compile(r"^([a-z][a-z0-9+.-]*://)[^/@?#]*@", re.IGNORECASE)
_URL_PARAM = re.compile(r"([?&#])([^=&#]+)=([^&#]*)")


def is_sensitive_key(key: str) -> bool:
    return _SENSITIVE_KEY.search(key) is not None


# The Luhn check keeps timestamps and order numbers of card length.
def _passes_luhn(digits: str) -> bool:
    total = 0
    for index, character in enumerate(reversed(digits)):
        digit = int(character)
        if index % 2 == 1:
            digit *= 2
        if digit > 9:
            digit -= 9
        total += digit
    return total % 10 == 0


def _filter_card(match: re.Match[str]) -> str:
    digits = re.sub(r"\D", "", match.group(0))
    return FILTERED if _passes_luhn(digits) else match.group(0)


def scrub_text(text: str) -> str:
    return _CARD_NUMBER.sub(_filter_card, text)


def _filter_param(match: re.Match[str]) -> str:
    separator, key = match.group(1), match.group(2)
    if is_sensitive_key(unquote(key)):
        return f"{separator}{key}={FILTERED}"
    return match.group(0)


# OAuth redirects put tokens in the hash as well as the query, and a card
# number can sit in any parameter, so URLs get the text filter too.
def scrub_url(url: str) -> str:
    without_credentials = _URL_CREDENTIALS.sub(r"\1", url)
    return scrub_text(_URL_PARAM.sub(_filter_param, without_credentials))


def _scrub_string(value: str) -> str:
    if _URL.match(value):
        return scrub_url(value)
    return scrub_text(value)


# ancestors holds the containers on the current path only, so a value used
# twice (billing and shipping address) is kept and only a real cycle is cut.
def _scrub_nested(key: str, value: Any, depth: int, ancestors: Set[int]) -> Any:
    if is_sensitive_key(key):
        return FILTERED
    if isinstance(value, str):
        return _scrub_string(value)
    if not isinstance(value, (Mapping, list, tuple, set, frozenset)):
        return value
    if id(value) in ancestors:
        return CIRCULAR
    if depth >= MAX_DEPTH:
        return TRUNCATED
    ancestors.add(id(value))
    try:
        if isinstance(value, Mapping):
            return {
                str(child_key): _scrub_nested(str(child_key), child, depth + 1, ancestors)
                for child_key, child in value.items()
            }
        return [
            _scrub_nested(str(index), child, depth + 1, ancestors)
            for index, child in enumerate(value)
        ]
    finally:
        ancestors.discard(id(value))


def scrub_value(key: str, value: Any) -> Any:
    return _scrub_nested(key, value, 0, set())
