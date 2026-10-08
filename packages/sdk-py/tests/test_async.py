"""AsyncKestrel shares its request building and error mapping with Kestrel (``_base.py``);
these tests cover what it does on its own: the awaited retry loop, paging and polling."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from kestrel_browser import ApiError, AsyncKestrel, KestrelConnectionError, SessionEndedError

from .conftest import SESSION_ID, api_error, event_json, session_json


def test_crud(api):
    create = api.post("/v1/sessions").respond(201, json=session_json())
    api.get(f"/v1/sessions/{SESSION_ID}").respond(200, json=session_json())
    api.post(f"/v1/sessions/{SESSION_ID}/stop").respond(200, json=session_json(status="stopping"))
    api.get("/v1/sessions").respond(200, json={"data": [session_json()], "nextCursor": None})

    async def run():
        async with AsyncKestrel() as k:
            s = await k.sessions.create(timeout=60_000)
            assert s.id == SESSION_ID
            assert (await k.sessions.get(SESSION_ID)).status == "ready"
            assert (await k.sessions.stop(SESSION_ID)).status == "stopping"
            assert (await k.sessions.list(limit=1)).next_cursor is None

    asyncio.run(run())
    sent = json.loads(create.calls.last.request.content)
    assert sent["timeout"] == 60_000
    assert create.calls.last.request.headers["authorization"] == "Bearer ksl_test"


def test_retries_with_retry_after_and_the_same_key(api, sleeps):
    route = api.post("/v1/sessions").mock(
        side_effect=[
            httpx.Response(503, json=api_error("capacity_exhausted"), headers={"retry-after": "1"}),
            httpx.Response(429, json=api_error("quota_exceeded"), headers={"retry-after": "2"}),
            httpx.Response(201, json=session_json()),
        ]
    )

    async def run():
        async with AsyncKestrel() as k:
            await k.sessions.create()

    asyncio.run(run())
    assert sleeps == [1.0, 2.0]
    keys = {json.loads(c.request.content)["idempotencyKey"] for c in route.calls}
    assert len(keys) == 1


def test_errors(api):
    api.get(f"/v1/sessions/{SESSION_ID}").respond(401, json=api_error("unauthorized"))
    api.get("/v1/sessions").mock(side_effect=httpx.ConnectTimeout("slow"))

    async def run():
        async with AsyncKestrel(max_retries=1) as k:
            with pytest.raises(ApiError) as e:
                await k.sessions.get(SESSION_ID)
            assert e.value.code == "unauthorized"
            with pytest.raises(KestrelConnectionError):
                await k.sessions.list()

    asyncio.run(run())


def test_iter_events_follow(api, sleeps):
    e1 = event_json(1, "session.requested")
    e2 = event_json(2, "session.ended", {"endReason": "idle_timeout", "status": "timed_out"})
    api.get(f"/v1/sessions/{SESSION_ID}/events").mock(
        side_effect=[
            httpx.Response(200, json={"data": [e1], "nextCursor": None}),
            httpx.Response(200, json={"data": [e1, e2], "nextCursor": None}),
        ]
    )

    async def run():
        async with AsyncKestrel() as k:
            return [e.id async for e in k.sessions.iter_events(SESSION_ID, follow=True)]

    assert asyncio.run(run()) == ["evt_1", "evt_2"]
    assert sleeps == [1.0]


def test_wait_until_ready(api):
    api.get(f"/v1/sessions/{SESSION_ID}").mock(
        side_effect=[
            httpx.Response(200, json=session_json(status="scheduling")),
            httpx.Response(200, json=session_json(status="ready")),
            httpx.Response(200, json=session_json(status="failed", endReason="node_lost")),
        ]
    )

    async def run():
        async with AsyncKestrel() as k:
            assert (await k.sessions.wait_until_ready(SESSION_ID)).status == "ready"
            with pytest.raises(SessionEndedError):
                await k.sessions.wait_until_ready(SESSION_ID)

    asyncio.run(run())
