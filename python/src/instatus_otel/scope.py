from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Dict, Iterator, Mapping, NamedTuple, Optional, Tuple

from opentelemetry import trace

from .event import Event, Level


class Scope:
    def __init__(self) -> None:
        self.user: Optional[Dict[str, Any]] = None
        self.level: Optional[Level] = None
        self.tags: Dict[str, Any] = {}
        self.extra: Dict[str, Any] = {}
        self.contexts: Dict[str, Any] = {}

    def clone(self) -> Scope:
        copy = Scope()
        copy.user = self.user
        copy.level = self.level
        copy.tags = dict(self.tags)
        copy.extra = dict(self.extra)
        copy.contexts = dict(self.contexts)
        return copy

    def set_user(self, user: Optional[Mapping[str, Any]]) -> Scope:
        self.user = dict(user) if user else None
        return self

    def set_tag(self, key: str, value: Any) -> Scope:
        self.tags[key] = value
        return self

    def set_tags(self, tags: Mapping[str, Any]) -> Scope:
        self.tags.update(tags)
        return self

    def set_context(self, name: str, value: Optional[Mapping[str, Any]]) -> Scope:
        if value is None:
            self.contexts.pop(name, None)
        else:
            self.contexts[name] = dict(value)
        return self

    def set_extra(self, key: str, value: Any) -> Scope:
        self.extra[key] = value
        return self

    def set_extras(self, extras: Mapping[str, Any]) -> Scope:
        self.extra.update(extras)
        return self

    def set_level(self, level: Optional[Level]) -> Scope:
        self.level = level
        return self

    def update(
        self,
        *,
        user: Optional[Mapping[str, Any]] = None,
        level: Optional[Level] = None,
        tags: Optional[Mapping[str, Any]] = None,
        extras: Optional[Mapping[str, Any]] = None,
        contexts: Optional[Mapping[str, Optional[Mapping[str, Any]]]] = None,
    ) -> Scope:
        if user:
            self.set_user(user)
        if level:
            self.set_level(level)
        if tags:
            self.set_tags(tags)
        if extras:
            self.set_extras(extras)
        for name, value in (contexts or {}).items():
            self.set_context(name, value)
        return self

    def clear(self) -> Scope:
        self.user = None
        self.level = None
        self.tags = {}
        self.extra = {}
        self.contexts = {}
        return self

    def apply(self, event: Event) -> Event:
        applied: Event = {
            **event,
            "tags": {**self.tags, **event["tags"]},
            "extra": {**self.extra, **event["extra"]},
            "contexts": {**self.contexts, **event["contexts"]},
        }
        if self.level:
            applied["level"] = self.level
        user = event.get("user") or self.user
        if user:
            applied["user"] = user
        return applied


class _Bound(NamedTuple):
    scope: Scope
    trace_id: Optional[int]
    owner: Tuple[int, int]


_global_scope = Scope()
_current: ContextVar[Optional[_Bound]] = ContextVar("instatus_otel_scope", default=None)


def get_global_scope() -> Scope:
    return _global_scope


def _running_task() -> Optional[asyncio.Task[Any]]:
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


def _owner() -> Tuple[int, int]:
    return threading.get_ident(), id(_running_task())


def _active_trace_id() -> Optional[int]:
    span_context = trace.get_current_span().get_span_context()
    return span_context.trace_id if span_context.is_valid else None


# Pool threads keep one context across requests, so a scope set during one
# traced request is not reused by the next request's trace.
def _live_bound() -> Optional[_Bound]:
    bound = _current.get()
    if bound is None or bound.trace_id is None:
        return bound
    active = _active_trace_id()
    if active is not None and active != bound.trace_id:
        return None
    return bound


def get_current_scope() -> Scope:
    bound = _live_bound()
    return bound.scope if bound else _global_scope


def _is_startup() -> bool:
    return (
        _current.get() is None
        and threading.current_thread() is threading.main_thread()
        and _running_task() is None
        and _active_trace_id() is None
    )


# Startup code (the main thread, outside any task, scope or span) sets the global
# scope that every thread sees. A task or thread that inherited a scope gets
# its own copy on its first change, so concurrent work never shares a user.
def update_current_scope(change: Callable[[Scope], Any]) -> None:
    bound = _live_bound()
    if bound is not None and bound.owner == _owner():
        change(bound.scope)
        return
    if _is_startup():
        change(_global_scope)
        return
    scope = get_current_scope().clone()
    change(scope)
    _current.set(_Bound(scope, _active_trace_id(), _owner()))


@contextmanager
def with_scope() -> Iterator[Scope]:
    scope = get_current_scope().clone()
    token = _current.set(_Bound(scope, None, _owner()))
    try:
        yield scope
    finally:
        _current.reset(token)
