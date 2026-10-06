from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx

from kestrel_sdk import (
    ApiError,
    CaptchaOptions,
    Kestrel,
    KestrelConnectionError,
    KestrelError,
    NetworkPolicy,
    ProxyConfig,
    SessionEndedError,
    SessionProxy,
    Viewport,
)

from .conftest import (
    CONNECT_URL,
    SESSION_ID,
    api_error,
    event_json,
    session_json,
)


def body(call: respx.models.Call) -> dict:
    return json.loads(call.request.content)


class TestConfiguration:
    def test_reads_key_and_url_from_the_environment(self, monkeypatch):
        monkeypatch.setenv("KESTREL_URL", "https://kestrel.example/api")
        assert Kestrel().base_url == "https://kestrel.example/api/"

    def test_refuses_to_start_without_a_key(self, monkeypatch):
        monkeypatch.delenv("KESTREL_API_KEY")
        with pytest.raises(KestrelError, match="KESTREL_API_KEY"):
            Kestrel()

    def test_keeps_a_path_prefix(self, api):
        api.get(f"/prefix/v1/sessions/{SESSION_ID}").respond(200, json=session_json())
        k = Kestrel(base_url="http://api.test/prefix")
        assert k.sessions.get(SESSION_ID).id == SESSION_ID


class TestSessions:
    def test_create_sends_options_key_and_idempotency_key(self, api):
        route = api.post("/v1/sessions").respond(201, json=session_json())
        s = Kestrel().sessions.create(
            timeout=60_000,
            idle_timeout=30_000,
            viewport=Viewport(800, 600),
            network=NetworkPolicy(allow=["example.com"]),
            metadata={"run": "1"},
        )
        assert s.id == SESSION_ID
        assert s.status == "ready"
        assert s.created_at == datetime(2026, 10, 3, 10, 0, tzinfo=timezone.utc)
        assert s.options.idle_timeout == 300_000
        req = route.calls.last.request
        assert req.headers["authorization"] == "Bearer ksl_test"
        sent = body(route.calls.last)
        key = sent.pop("idempotencyKey")
        assert len(key) == 36
        assert sent == {
            "timeout": 60_000,
            "idleTimeout": 30_000,
            "viewport": {"width": 800, "height": 600},
            "network": {"allow": ["example.com"]},
            "metadata": {"run": "1"},
        }

    def test_create_uses_the_callers_key_and_accepts_dicts(self, api):
        route = api.post("/v1/sessions").respond(200, json=session_json())
        Kestrel().sessions.create(idempotency_key="mine", viewport={"width": 800, "height": 600})
        assert body(route.calls.last) == {
            "idempotencyKey": "mine",
            "viewport": {"width": 800, "height": 600},
        }

    def test_get_stop_list(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").respond(200, json=session_json())
        stop = api.post(f"/v1/sessions/{SESSION_ID}/stop").respond(
            200, json=session_json(status="stopping", connectUrl=None)
        )
        lst = api.get("/v1/sessions").respond(
            200, json={"data": [session_json()], "nextCursor": "abc"}
        )
        k = Kestrel()
        assert k.sessions.get(SESSION_ID).connect_url == CONNECT_URL
        assert k.sessions.stop(SESSION_ID).status == "stopping"
        assert stop.calls.last.request.content == b""
        page = k.sessions.list(status="ready", limit=5)
        assert page.next_cursor == "abc"
        assert [s.id for s in page.data] == [SESSION_ID]
        assert dict(lst.calls.last.request.url.params) == {"status": "ready", "limit": "5"}

    def test_unknown_fields_are_ignored_and_kept_on_raw(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").respond(
            200, json=session_json(status="paused", newField=1)
        )
        s = Kestrel().sessions.get(SESSION_ID)
        assert s.status == "paused"
        assert s.raw["newField"] == 1

    def test_create_sends_a_proxy_and_keeps_its_password_out_of_repr(self, api):
        options = dict(session_json()["options"])
        options["proxy"] = {"server": "http://proxy.example.com:3128", "username": "u"}
        route = api.post("/v1/sessions").respond(201, json=session_json(options=options))
        config = ProxyConfig("http://proxy.example.com:3128", "u", "pr0xy-py")
        assert "pr0xy-py" not in repr(config)
        s = Kestrel().sessions.create(proxy=config)
        assert body(route.calls.last)["proxy"] == {
            "server": "http://proxy.example.com:3128",
            "username": "u",
            "password": "pr0xy-py",
        }
        assert s.options.proxy == SessionProxy("http://proxy.example.com:3128", "u")
        Kestrel().sessions.create(proxy={"server": "http://p.example.com:8080"})
        assert body(route.calls.last)["proxy"] == {"server": "http://p.example.com:8080"}

    def test_create_asks_for_captcha_solving_and_reads_the_solve_state(self, api):
        options = dict(session_json()["options"])
        options["captcha"] = {"solve": True}
        route = api.post("/v1/sessions").respond(201, json=session_json(options=options))
        s = Kestrel().sessions.create(captcha=CaptchaOptions(solve=True))
        assert body(route.calls.last)["captcha"] == {"solve": True}
        assert s.options.captcha == CaptchaOptions(solve=True)
        Kestrel().sessions.create()
        assert "captcha" not in body(route.calls.last)
        api.get(f"/v1/sessions/{SESSION_ID}").respond(
            200,
            json=session_json(
                captcha={
                    "providers": ["recaptcha"],
                    "since": "2026-10-05T10:00:00.000Z",
                    "solve": {
                        "provider": "recaptcha",
                        "status": "failed",
                        "at": "2026-10-05T10:00:03.000Z",
                        "reason": "solver_error",
                    },
                }
            ),
        )
        got = Kestrel().sessions.get(SESSION_ID)
        assert got.captcha is not None and got.captcha.solve is not None
        assert (got.captcha.solve.status, got.captcha.solve.reason) == ("failed", "solver_error")

    def test_repr_hides_the_connect_url(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").respond(200, json=session_json())
        assert "secret-token" not in repr(Kestrel().sessions.get(SESSION_ID))


class TestErrorsAndRetries:
    def test_non_retryable_error_is_raised_at_once(self, api, sleeps):
        route = api.get(f"/v1/sessions/{SESSION_ID}").respond(404, json=api_error("not_found"))
        with pytest.raises(ApiError) as e:
            Kestrel().sessions.get(SESSION_ID)
        assert (e.value.status, e.value.code, e.value.retryable, e.value.request_id) == (
            404,
            "not_found",
            False,
            "req-1",
        )
        assert route.call_count == 1
        assert sleeps == []

    def test_param_on_invalid_request(self, api):
        api.post("/v1/sessions").respond(400, json=api_error("invalid_request", param="timeout"))
        with pytest.raises(ApiError) as e:
            Kestrel().sessions.create(timeout=1)
        assert e.value.param == "timeout"

    def test_capacity_exhausted_is_retried_with_the_same_key(self, api, sleeps):
        full = httpx.Response(503, json=api_error("capacity_exhausted"))
        route = api.post("/v1/sessions").mock(
            side_effect=[full, full, httpx.Response(201, json=session_json())]
        )
        Kestrel(retry_base_delay=0.5).sessions.create(wait_for_capacity_ms=1000)
        assert route.call_count == 3
        assert len({body(c)["idempotencyKey"] for c in route.calls}) == 1
        assert len(sleeps) == 2
        assert 0 <= sleeps[0] <= 0.5 and 0 <= sleeps[1] <= 1.0

    def test_gives_up_after_max_retries(self, api):
        route = api.post("/v1/sessions").respond(503, json=api_error("capacity_exhausted"))
        with pytest.raises(ApiError) as e:
            Kestrel(max_retries=2).sessions.create()
        assert e.value.code == "capacity_exhausted"
        assert route.call_count == 3

    def test_429_waits_for_retry_after(self, api, sleeps):
        api.post("/v1/sessions").mock(
            side_effect=[
                httpx.Response(429, json=api_error("quota_exceeded"), headers={"retry-after": "7"}),
                httpx.Response(201, json=session_json()),
            ]
        )
        Kestrel().sessions.create()
        assert sleeps == [7.0]

    def test_in_progress_conflict_retried_but_reused_key_is_not(self, api):
        route = api.post("/v1/sessions").mock(
            side_effect=[
                httpx.Response(409, json=api_error("conflict")),
                httpx.Response(200, json=session_json()),
            ]
        )
        Kestrel().sessions.create(idempotency_key="k")
        assert route.call_count == 2

        # respx hands back the same route for the same pattern, so clear its count first.
        route.reset()
        route.respond(409, json=api_error("conflict", retryable=False, param="idempotencyKey"))
        with pytest.raises(ApiError):
            Kestrel().sessions.create(idempotency_key="k", timeout=5000)
        assert route.call_count == 1

    def test_malformed_error_body(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").respond(418, text="teapot")
        with pytest.raises(ApiError) as e:
            Kestrel().sessions.get(SESSION_ID)
        assert (e.value.code, e.value.retryable) == ("malformed_response", False)

    def test_bad_gateway_from_a_proxy_is_retried(self, api):
        route = api.get(f"/v1/sessions/{SESSION_ID}").mock(
            side_effect=[
                httpx.Response(502, text="<html>bad gateway</html>"),
                httpx.Response(200, json=session_json()),
            ]
        )
        Kestrel().sessions.get(SESSION_ID)
        assert route.call_count == 2

    def test_connection_failure_is_retried_then_raised(self, api):
        route = api.get(f"/v1/sessions/{SESSION_ID}").mock(
            side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(KestrelConnectionError, match="refused"):
            Kestrel(max_retries=1).sessions.get(SESSION_ID)
        assert route.call_count == 2


class TestWaitUntilReady:
    def test_polls_until_ready(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").mock(
            side_effect=[
                httpx.Response(200, json=session_json(status="starting")),
                httpx.Response(200, json=session_json(status="active")),
            ]
        )
        assert Kestrel().sessions.wait_until_ready(SESSION_ID).status == "active"

    def test_raises_when_the_session_ends_first(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").respond(
            200, json=session_json(status="failed", endReason="start_timeout")
        )
        with pytest.raises(SessionEndedError) as e:
            Kestrel().sessions.wait_until_ready(SESSION_ID)
        assert e.value.session.end_reason == "start_timeout"

    def test_gives_up_after_its_timeout(self, api):
        api.get(f"/v1/sessions/{SESSION_ID}").respond(200, json=session_json(status="starting"))
        with pytest.raises(KestrelError, match="still starting"):
            Kestrel().sessions.wait_until_ready(SESSION_ID, timeout=0)


class TestIterEvents:
    def test_walks_every_page(self, api):
        def page(request: httpx.Request) -> httpx.Response:
            if request.url.params.get("cursor") == "p2":
                return httpx.Response(
                    200, json={"data": [event_json(2, "session.starting")], "nextCursor": None}
                )
            return httpx.Response(
                200, json={"data": [event_json(1, "session.requested")], "nextCursor": "p2"}
            )

        api.get(f"/v1/sessions/{SESSION_ID}/events").mock(side_effect=page)
        types = [e.type for e in Kestrel().sessions.iter_events(SESSION_ID)]
        assert types == ["session.requested", "session.starting"]

    def test_follow_skips_repeats_and_stops_when_the_session_ends(self, api, sleeps):
        e1 = event_json(1, "session.requested")
        e2 = event_json(2, "session.ready", {"startPath": "hot", "readyMs": 900})
        e3 = event_json(3, "session.ended", {"endReason": "client_stop", "status": "stopped"})
        pages = [[e1], [e1], [e1, e2], [e1, e2, e3]]
        route = api.get(f"/v1/sessions/{SESSION_ID}/events").mock(
            side_effect=[httpx.Response(200, json={"data": p, "nextCursor": None}) for p in pages]
        )
        events = list(Kestrel().sessions.iter_events(SESSION_ID, follow=True, poll_interval=0.25))
        assert [e.id for e in events] == ["evt_1", "evt_2", "evt_3"]
        assert events[1].data == {"startPath": "hot", "readyMs": 900}
        assert route.call_count == 4
        assert sleeps == [0.25, 0.25, 0.25]
