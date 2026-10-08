"""connect() with a stand-in for Playwright, so no browser is needed: what matters is the
order of create, attach, close and stop, and that a failure never leaves a session running."""

from __future__ import annotations

import asyncio
import sys
import types
from typing import Any

import httpx
import pytest

from kestrel_browser import AsyncKestrel, Kestrel, KestrelError

from .conftest import CONNECT_URL, SESSION_ID, session_json


class FakePlaywright:
    def __init__(self, log: list[str], fail_connect: bool = False) -> None:
        self.log = log
        self.fail_connect = fail_connect
        self.chromium = self

    # chromium.connect_over_cdp
    def connect_over_cdp(self, url: str, timeout: float) -> Any:
        self.log.append(f"connect {url} {timeout:.0f}")
        if self.fail_connect:
            raise RuntimeError("WebSocket error")
        browser = types.SimpleNamespace(close=lambda: self.log.append("browser.close"))
        return browser

    def stop(self) -> None:
        self.log.append("playwright.stop")

    def start(self) -> FakePlaywright:
        return self


class AsyncFakePlaywright(FakePlaywright):
    async def connect_over_cdp(self, url: str, timeout: float) -> Any:  # type: ignore[override]
        browser = FakePlaywright.connect_over_cdp(self, url, timeout)

        async def close() -> None:
            self.log.append("browser.close")

        return types.SimpleNamespace(close=close, inner=browser)

    async def stop(self) -> None:  # type: ignore[override]
        self.log.append("playwright.stop")

    async def start(self) -> AsyncFakePlaywright:  # type: ignore[override]
        return self


@pytest.fixture
def playwright(monkeypatch: pytest.MonkeyPatch):
    """Install a fake ``playwright`` package; returns its call log and a switch to fail."""
    state: dict[str, Any] = {"log": [], "fail": False}
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: FakePlaywright(state["log"], state["fail"])  # type: ignore[attr-defined]
    async_api = types.ModuleType("playwright.async_api")
    async_api.async_playwright = lambda: AsyncFakePlaywright(state["log"], state["fail"])  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    monkeypatch.setitem(sys.modules, "playwright.async_api", async_api)
    return state


@pytest.fixture
def routes(api, playwright):
    """create and stop, logged into the same list as the Playwright calls."""
    log = playwright["log"]

    def create(_: httpx.Request) -> httpx.Response:
        log.append("create")
        return httpx.Response(201, json=session_json())

    def stop(_: httpx.Request) -> httpx.Response:
        log.append("stop")
        return httpx.Response(200, json=session_json(status="stopping"))

    api.post("/v1/sessions").mock(side_effect=create)
    api.post(f"/v1/sessions/{SESSION_ID}/stop").mock(side_effect=stop)
    return api


def test_connect_and_close(routes, playwright):
    with Kestrel().connect(timeout=60_000, connect_timeout=5) as k:
        assert k.session.id == SESSION_ID
        assert playwright["log"] == ["create", f"connect {CONNECT_URL} 5000"]
    assert playwright["log"][2:] == ["browser.close", "playwright.stop", "stop"]
    k.close()  # a second close does nothing
    assert playwright["log"].count("stop") == 1


def test_failed_attach_stops_the_session(routes, playwright):
    playwright["fail"] = True
    with pytest.raises(RuntimeError, match="WebSocket error"):
        Kestrel().connect()
    assert playwright["log"] == [
        "create",
        f"connect {CONNECT_URL} 30000",
        "playwright.stop",
        "stop",
    ]


def test_without_playwright_no_session_is_created(api, monkeypatch):
    monkeypatch.setitem(sys.modules, "playwright", None)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
    route = api.post("/v1/sessions")
    with pytest.raises(KestrelError, match=r"kestrel-browser\[playwright\]"):
        Kestrel().connect()
    assert route.call_count == 0


def test_async_connect_and_close(routes, playwright):
    async def run():
        async with AsyncKestrel() as client, await client.connect() as k:
            assert k.session.connect_url == CONNECT_URL

    asyncio.run(run())
    assert playwright["log"] == [
        "create",
        f"connect {CONNECT_URL} 30000",
        "browser.close",
        "playwright.stop",
        "stop",
    ]


def test_async_failed_attach_stops_the_session(routes, playwright):
    playwright["fail"] = True

    async def run():
        async with AsyncKestrel() as client:
            await client.connect()

    with pytest.raises(RuntimeError):
        asyncio.run(run())
    assert playwright["log"][-1] == "stop"
