"""Tokens and live view (W1, W2), /computer (W4) and /recording (W3), sync and async."""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest

from kestrel_browser import ApiError, AsyncKestrel, Kestrel

from .conftest import SESSION_ID, api_error, session_json

VIEWER = f"https://kestrel.test/live/{SESSION_ID}#ws=x&token=secret-token"
TOKEN = {
    "scope": "view",
    "token": "secret-token",
    "url": VIEWER,
    "expiresAt": "2026-10-03T10:10:00.000Z",
}
PNG = b"\x89PNG\r\n\x1a\nfake"
VIDEO = b"\x00\x00\x00\x18ftypisom" + b"fragment" * 20_000
TOKENS = f"/v1/sessions/{SESSION_ID}/tokens"
COMPUTER = f"/v1/sessions/{SESSION_ID}/computer"
RECORDING = f"/v1/sessions/{SESSION_ID}/recording"


def sent(route) -> list[dict]:
    return [json.loads(c.request.content) for c in route.calls]


def test_create_with_recording(api):
    route = api.post("/v1/sessions").respond(
        201,
        json=session_json(options={**session_json()["options"], "recording": True}),
    )
    s = Kestrel().sessions.create(recording=True)
    assert s.options.recording is True
    assert sent(route)[0]["recording"] is True


def test_mint_token_and_live_view_url(api):
    route = api.post(TOKENS).respond(201, json=TOKEN)
    k = Kestrel()
    t = k.sessions.mint_token(SESSION_ID, "cdp", single_use=True)
    assert t.url == VIEWER
    assert "secret-token" not in repr(t)
    assert k.sessions.live_view_url(SESSION_ID) == VIEWER
    k.sessions.live_view_url(SESSION_ID, control=True, ttl_ms=60_000)
    assert sent(route) == [
        {"scope": "cdp", "singleUse": True},
        {"scope": "view"},
        {"scope": "control", "ttlMs": 60_000},
    ]


def test_computer(api):
    route = api.post(COMPUTER).respond(
        200,
        json={
            "ok": True,
            "screenshot": base64.b64encode(PNG).decode(),
            "width": 1280,
            "height": 720,
            "url": "https://example.com/",
        },
    )
    r = Kestrel().sessions.computer(SESSION_ID, "click", x=10, y=20, screenshot=True)
    assert (r.width, r.height, r.url) == (1280, 720, "https://example.com/")
    assert r.screenshot_png == PNG
    assert sent(route) == [{"action": "click", "x": 10, "y": 20, "screenshot": True}]


def test_computer_conflict_when_not_running(api):
    api.post(COMPUTER).respond(409, json=api_error("conflict", retryable=False))
    with pytest.raises(ApiError) as e:
        Kestrel().sessions.computer(SESSION_ID, "screenshot")
    assert e.value.code == "conflict"


def test_recording_retries_before_the_body_then_streams(api):
    route = api.get(RECORDING).mock(
        side_effect=[
            httpx.Response(500, json=api_error("internal")),
            httpx.Response(200, content=VIDEO, headers={"content-type": "video/mp4"}),
            httpx.Response(200, content=VIDEO, headers={"content-type": "video/mp4"}),
        ]
    )
    k = Kestrel()
    assert k.sessions.recording(SESSION_ID) == VIDEO
    assert route.call_count == 2
    chunks = list(k.sessions.iter_recording(SESSION_ID, chunk_size=1024))
    assert len(chunks) > 1 and b"".join(chunks) == VIDEO


def test_save_recording(api, tmp_path):
    api.get(RECORDING).respond(200, content=VIDEO, headers={"content-type": "video/mp4"})
    out = tmp_path / "s.mp4"
    assert Kestrel().sessions.save_recording(SESSION_ID, out) == len(VIDEO)
    assert out.read_bytes() == VIDEO
    assert list(tmp_path.iterdir()) == [out]


def test_save_recording_of_unrecorded_session_leaves_no_file(api, tmp_path):
    api.get(RECORDING).respond(404, json=api_error("not_found", "This session was not recorded."))
    with pytest.raises(ApiError, match="not recorded"):
        Kestrel().sessions.save_recording(SESSION_ID, tmp_path / "s.mp4")
    assert list(tmp_path.iterdir()) == []


def test_async_surface(api, tmp_path):
    tokens = api.post(TOKENS).respond(201, json=TOKEN)
    computer = api.post(COMPUTER).respond(
        200, json={"ok": True, "width": 800, "height": 600, "url": "about:blank"}
    )
    api.get(RECORDING).mock(
        side_effect=[
            httpx.Response(503, json=api_error("capacity_exhausted")),
            httpx.Response(200, content=VIDEO),
            httpx.Response(200, content=VIDEO),
        ]
    )
    out = tmp_path / "a.mp4"

    async def run():
        async with AsyncKestrel() as k:
            assert await k.sessions.live_view_url(SESSION_ID, control=True) == VIEWER
            r = await k.sessions.computer(SESSION_ID, "type", text="hello")
            assert r.screenshot_png is None
            assert await k.sessions.recording(SESSION_ID) == VIDEO
            assert await k.sessions.save_recording(SESSION_ID, out) == len(VIDEO)

    asyncio.run(run())
    assert sent(tokens) == [{"scope": "control"}]
    assert sent(computer) == [{"action": "type", "text": "hello"}]
    assert out.read_bytes() == VIDEO
