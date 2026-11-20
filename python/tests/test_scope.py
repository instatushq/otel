from __future__ import annotations

import asyncio
import contextvars
import threading
from typing import Dict, List

import instatus_otel
from instatus_otel.attributes import ErrorLogRecord

from .conftest import Harness


def end_users(records: List[ErrorLogRecord]) -> Dict[str, str]:
    return {
        str(record.attributes["extra.request"]): str(record.attributes.get("enduser.id"))
        for record in records
    }


def test_threads_keep_their_own_user(harness: Harness) -> None:
    barrier = threading.Barrier(4)

    def handle(request: int) -> None:
        instatus_otel.set_user({"id": f"user-{request}"})
        instatus_otel.set_extra("request", request)
        barrier.wait()
        instatus_otel.capture_message(f"request {request} failed", "error")

    threads = [threading.Thread(target=handle, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert end_users(harness.records) == {str(index): f"user-{index}" for index in range(4)}
    assert instatus_otel.get_global_scope().user is None


def test_asyncio_tasks_keep_their_own_user(harness: Harness) -> None:
    async def handle(request: int) -> None:
        instatus_otel.set_user({"id": f"user-{request}"})
        instatus_otel.set_extra("request", request)
        await asyncio.sleep(0.01)
        instatus_otel.capture_message(f"request {request} failed", "error")

    async def serve() -> None:
        await asyncio.gather(*(handle(index) for index in range(4)))

    asyncio.run(serve())
    assert end_users(harness.records) == {str(index): f"user-{index}" for index in range(4)}
    assert instatus_otel.get_global_scope().user is None


def test_child_tasks_inherit_without_leaking_back(harness: Harness) -> None:
    async def child() -> None:
        instatus_otel.set_tag("child", True)

    async def parent() -> None:
        instatus_otel.set_tag("parent", True)
        await asyncio.create_task(child())
        instatus_otel.capture_message("parent", "error")

    asyncio.run(parent())
    attributes = harness.records[0].attributes
    assert attributes["parent"] is True
    assert "child" not in attributes


def test_startup_scope_reaches_every_thread(harness: Harness) -> None:
    instatus_otel.set_tag("region", "eu")
    thread = threading.Thread(target=instatus_otel.capture_message, args=("worker", "error"))
    thread.start()
    thread.join()
    assert harness.records[0].attributes["region"] == "eu"


def test_with_scope_is_a_copy(harness: Harness) -> None:
    instatus_otel.set_tag("region", "eu")
    with instatus_otel.with_scope() as scope:
        scope.set_tag("job", "invoice")
        instatus_otel.set_user({"id": "u1"})
        instatus_otel.capture_message("inside", "error")
    instatus_otel.capture_message("outside", "error")
    inside, outside = (record.attributes for record in harness.records)
    assert (inside["region"], inside["job"], inside["enduser.id"]) == ("eu", "invoice", "u1")
    assert outside["region"] == "eu"
    assert "job" not in outside and "enduser.id" not in outside


def test_with_scope_in_threads(harness: Harness) -> None:
    def handle(request: int) -> None:
        with instatus_otel.with_scope():
            instatus_otel.set_extra("request", request)
            instatus_otel.set_user({"id": f"user-{request}"})
            instatus_otel.capture_message(f"request {request} failed", "error")
        instatus_otel.capture_message("after", "error")

    thread = threading.Thread(target=handle, args=(1,))
    thread.start()
    thread.join()
    inside, after = harness.records
    assert inside.attributes["enduser.id"] == "user-1"
    assert "enduser.id" not in after.attributes


def test_a_pool_thread_does_not_reuse_the_last_requests_user(harness: Harness) -> None:
    worker_context = contextvars.copy_context()

    def request(user: str) -> None:
        with instatus_otel.start_span("request"):
            if user:
                instatus_otel.set_user({"id": user})
            instatus_otel.capture_message(f"request for {user or 'nobody'} failed", "error")

    def run(user: str) -> None:
        worker_context.run(request, user)

    for user in ("signed-in", ""):
        thread = threading.Thread(target=run, args=(user,))
        thread.start()
        thread.join()
    first, second = harness.records
    assert first.attributes["enduser.id"] == "signed-in"
    assert "enduser.id" not in second.attributes


def test_main_thread_requests_keep_their_own_user(harness: Harness) -> None:
    def request(user: str) -> None:
        with instatus_otel.start_span("request"):
            instatus_otel.capture_message(f"before {user}", "error")
            instatus_otel.set_user({"id": user})
            instatus_otel.set_tag("route", user)
            instatus_otel.capture_message(f"request for {user} failed", "error")

    request("first")
    request("second")
    worker = threading.Thread(target=instatus_otel.capture_message, args=("worker", "error"))
    worker.start()
    worker.join()

    before_first, first, before_second, second, after = (
        record.attributes for record in harness.records
    )
    assert first["enduser.id"] == "first" and first["route"] == "first"
    assert second["enduser.id"] == "second" and second["route"] == "second"
    for attributes in (before_first, before_second, after):
        assert "enduser.id" not in attributes and "route" not in attributes
    assert instatus_otel.get_global_scope().user is None
    assert instatus_otel.get_global_scope().tags == {}


def test_main_thread_tags_outside_a_span_stay_global(harness: Harness) -> None:
    instatus_otel.set_tag("region", "eu")
    with instatus_otel.start_span("request"):
        instatus_otel.set_user({"id": "u1"})
    assert instatus_otel.get_global_scope().tags == {"region": "eu"}
    assert instatus_otel.get_global_scope().user is None
