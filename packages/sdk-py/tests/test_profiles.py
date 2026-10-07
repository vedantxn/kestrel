"""Profiles (``/v1/profiles``) and sessions that start from one, in both clients."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest

from kestrel_sdk import (
    ApiError,
    AsyncKestrel,
    Kestrel,
    KestrelConnectionError,
    SessionProfile,
    _async,
    _sync,
)

from .conftest import SESSION_ID, api_error, session_json

PROFILE_ID = "prf_01k6e4m9t8f2xq3w5y7z9a1b2c"


def profile_json(**overrides: Any) -> dict[str, Any]:
    p: dict[str, Any] = {
        "id": PROFILE_ID,
        "name": "work",
        "metadata": {},
        "version": 0,
        "bytes": 0,
        "savedAt": None,
        "savedBySessionId": None,
        "chromeMajor": None,
        "inUseBy": None,
        "createdAt": "2026-10-07T10:00:00.000Z",
    }
    p.update(overrides)
    return p


def busy() -> httpx.Response:
    """The API's answer while another session is saving into the profile."""
    return httpx.Response(
        409,
        json=api_error(
            "conflict",
            "Another session is saving into this profile; only one may at a time.",
            param="profile.id",
        ),
    )


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch, sleeps: list[float]) -> list[float]:
    """Recorded sleeps also move ``time.monotonic`` forward, so a deadline can pass."""
    real = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real() + sum(sleeps))
    return sleeps


class TestProfiles:
    def test_create_get_list_delete(self, api):
        create = api.post("/v1/profiles").respond(201, json=profile_json(metadata={"team": "a"}))
        api.get(f"/v1/profiles/{PROFILE_ID}").respond(
            200,
            json=profile_json(
                version=2,
                bytes=4096,
                savedAt="2026-10-07T11:00:00.000Z",
                savedBySessionId=SESSION_ID,
                chromeMajor=154,
            ),
        )
        lst = api.get("/v1/profiles").respond(
            200, json={"data": [profile_json()], "nextCursor": "next"}
        )
        delete = api.delete(f"/v1/profiles/{PROFILE_ID}").respond(204)

        k = Kestrel()
        p = k.profiles.create(name="work", metadata={"team": "a"})
        assert (p.id, p.name, p.metadata, p.version, p.in_use_by) == (
            PROFILE_ID,
            "work",
            {"team": "a"},
            0,
            None,
        )
        assert json.loads(create.calls.last.request.content) == {
            "name": "work",
            "metadata": {"team": "a"},
        }

        got = k.profiles.get(PROFILE_ID)
        assert (got.version, got.bytes, got.chrome_major) == (2, 4096, 154)
        assert got.saved_at == datetime(2026, 10, 7, 11, 0, tzinfo=timezone.utc)
        assert got.saved_by_session_id == SESSION_ID

        page = k.profiles.list(limit=5, cursor="c1")
        assert page.next_cursor == "next"
        assert [x.id for x in page.data] == [PROFILE_ID]
        assert dict(lst.calls.last.request.url.params) == {"limit": "5", "cursor": "c1"}

        assert k.profiles.delete(PROFILE_ID) is None
        assert delete.call_count == 1

    def test_create_with_nothing_sends_an_empty_body(self, api):
        create = api.post("/v1/profiles").respond(201, json=profile_json(name=None))
        assert Kestrel().profiles.create().name is None
        assert json.loads(create.calls.last.request.content) == {}

    def test_not_configured_is_raised_at_once(self, api, sleeps):
        route = api.get("/v1/profiles").respond(
            400,
            json=api_error("invalid_request", "Profiles are not configured on this deployment."),
        )
        with pytest.raises(ApiError) as e:
            Kestrel().profiles.list()
        assert (e.value.status, e.value.code) == (400, "invalid_request")
        assert route.call_count == 1

    def test_a_create_the_api_says_changed_nothing_is_retried(self, api):
        route = api.post("/v1/profiles").mock(
            side_effect=[
                httpx.Response(500, json=api_error("internal")),
                httpx.Response(201, json=profile_json()),
            ]
        )
        assert Kestrel().profiles.create(name="work").id == PROFILE_ID
        assert route.call_count == 2

    def test_a_create_with_no_answer_is_not_repeated(self, api):
        create = api.post("/v1/profiles").mock(side_effect=httpx.ReadTimeout("slow"))
        get = api.get(f"/v1/profiles/{PROFILE_ID}").mock(side_effect=httpx.ReadTimeout("slow"))
        k = Kestrel(max_retries=2)
        with pytest.raises(KestrelConnectionError):
            k.profiles.create(name="work")
        assert create.call_count == 1
        # Reads are still retried.
        with pytest.raises(KestrelConnectionError):
            k.profiles.get(PROFILE_ID)
        assert get.call_count == 3

    def test_a_create_answered_by_a_proxy_is_not_repeated(self, api):
        route = api.post("/v1/profiles").respond(502, text="<html>bad gateway</html>")
        with pytest.raises(ApiError) as e:
            Kestrel().profiles.create()
        assert (e.value.code, e.value.retryable) == ("malformed_response", True)
        assert route.call_count == 1


class TestSessionsWithAProfile:
    def test_sends_the_profile_and_reads_it_back(self, api):
        options = dict(session_json()["options"])
        options["profile"] = {"id": PROFILE_ID, "persist": True}
        route = api.post("/v1/sessions").respond(
            201, json=session_json(options=options, startPath="warm")
        )
        s = Kestrel().sessions.create(profile=SessionProfile(PROFILE_ID, persist=True))
        assert json.loads(route.calls.last.request.content)["profile"] == {
            "id": PROFILE_ID,
            "persist": True,
        }
        assert s.options.profile == SessionProfile(PROFILE_ID, True)
        assert s.start_path == "warm"

    def test_a_busy_profile_is_raised_at_once_unless_asked_to_wait(self, api, sleeps):
        route = api.post("/v1/sessions").mock(
            side_effect=[busy(), httpx.Response(201, json=session_json())]
        )
        with pytest.raises(ApiError) as e:
            Kestrel().sessions.create(profile={"id": PROFILE_ID, "persist": True})
        assert (e.value.status, e.value.code, e.value.param, e.value.retryable) == (
            409,
            "conflict",
            "profile.id",
            True,
        )
        assert route.call_count == 1
        assert sleeps == []

    def test_wait_for_profile_ms_retries_past_max_retries_with_the_same_key(self, api, clock):
        route = api.post("/v1/sessions").mock(
            side_effect=[*(busy() for _ in range(5)), httpx.Response(201, json=session_json())]
        )
        s = Kestrel(max_retries=3).sessions.create(
            profile={"id": PROFILE_ID, "persist": True}, wait_for_profile_ms=60_000
        )
        assert s.id == SESSION_ID
        assert route.call_count == 6
        assert len({json.loads(c.request.content)["idempotencyKey"] for c in route.calls}) == 1
        assert len(clock) == 5

    def test_wait_for_profile_ms_gives_up_at_the_deadline(self, api, clock):
        route = api.post("/v1/sessions").mock(
            side_effect=lambda _req: httpx.Response(
                409,
                json=api_error("conflict", param="profile.id"),
                headers={"retry-after": "1"},
            )
        )
        with pytest.raises(ApiError) as e:
            Kestrel().sessions.create(
                profile={"id": PROFILE_ID, "persist": True}, wait_for_profile_ms=2_500
            )
        assert e.value.param == "profile.id"
        # 1 s, 1 s, then what is left (about 0.5 s), then a last attempt at the deadline.
        assert route.call_count == 4
        assert clock[:2] == [1.0, 1.0]
        assert 0 < clock[2] <= 0.5

    def test_wait_for_profile_ms_does_not_wait_on_other_conflicts(self, api, sleeps):
        route = api.post("/v1/sessions").respond(
            409, json=api_error("conflict", retryable=False, param="profile.id")
        )
        with pytest.raises(ApiError):
            Kestrel().sessions.create(profile={"id": PROFILE_ID}, wait_for_profile_ms=60_000)
        assert route.call_count == 1
        assert sleeps == []


def test_async_profiles_and_waiting(api):
    # The more specific route first: respx takes the first route that matches.
    no_answer = api.post("/v1/profiles", json={"name": "lost"}).mock(
        side_effect=httpx.ReadTimeout("slow")
    )
    api.post("/v1/profiles").respond(201, json=profile_json())
    api.get(f"/v1/profiles/{PROFILE_ID}").respond(200, json=profile_json())
    lst = api.get("/v1/profiles").respond(200, json={"data": [profile_json()], "nextCursor": None})
    api.delete(f"/v1/profiles/{PROFILE_ID}").respond(204)
    create = api.post("/v1/sessions").mock(
        side_effect=[busy(), busy(), busy(), busy(), httpx.Response(201, json=session_json())]
    )

    async def run():
        async with AsyncKestrel(max_retries=1) as k:
            assert (await k.profiles.create(name="work")).id == PROFILE_ID
            assert (await k.profiles.get(PROFILE_ID)).version == 0
            page = await k.profiles.list(limit=1)
            assert page.next_cursor is None
            assert await k.profiles.delete(PROFILE_ID) is None
            with pytest.raises(KestrelConnectionError):
                await k.profiles.create(name="lost")
            with pytest.raises(ApiError) as e:
                await k.sessions.create(profile={"id": PROFILE_ID, "persist": True})
            assert e.value.param == "profile.id"
            s = await k.sessions.create(
                profile={"id": PROFILE_ID, "persist": True}, wait_for_profile_ms=60_000
            )
            assert s.id == SESSION_ID

    asyncio.run(run())
    assert dict(lst.calls.last.request.url.params) == {"limit": "1"}
    assert no_answer.call_count == 1
    assert create.call_count == 5


def test_the_sync_and_async_clients_share_one_busy_check():
    assert _sync._base is _async._base
    err = ApiError(409, "conflict", "busy", True, param="profile.id")
    assert _sync._base.is_profile_busy(err)
    assert not _sync._base.is_profile_busy(
        ApiError(409, "conflict", "old Chrome", False, param="profile.id")
    )
    assert not _sync._base.is_profile_busy(
        ApiError(409, "conflict", "in progress", True, param="idempotencyKey")
    )
