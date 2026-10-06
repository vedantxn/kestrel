"""The asyncio client. Same surface and rules as ``_sync.py``, awaited."""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Any

import httpx

from . import _base
from ._errors import KestrelConnectionError, KestrelError, SessionEndedError
from ._types import (
    TERMINAL_STATUSES,
    ComputerActionName,
    ComputerResponse,
    NetworkPolicy,
    Page,
    ProxyConfig,
    Session,
    SessionEvent,
    SessionToken,
    TokenScope,
    Viewport,
)

# Indirection so tests can skip real waits.
_sleep = asyncio.sleep


class AsyncSessions:
    """``/v1/sessions`` and everything under it; see ``Sessions`` for each method."""

    def __init__(self, http: httpx.AsyncClient, config: _base.Config) -> None:
        self._http = http
        self._config = config

    async def _send(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        stream: bool = False,
    ) -> httpx.Response:
        attempt = 0
        while True:
            request = self._http.build_request(method, path, json=json, params=params)
            try:
                response = await self._http.send(request, stream=stream)
                if stream and not response.is_success:
                    await response.aread()
                    await response.aclose()
            except httpx.TransportError as e:
                if attempt >= self._config.max_retries:
                    raise KestrelConnectionError(
                        f"{method} {self._config.base_url}{path} failed: {_base.describe(e)}"
                    ) from e
                await _sleep(_base.backoff(self._config, attempt))
                attempt += 1
                continue
            if response.is_success:
                return response
            err = _base.to_api_error(response)
            if not err.retryable or attempt >= self._config.max_retries:
                raise err
            await _sleep(
                err.retry_after
                if err.retry_after is not None
                else _base.backoff(self._config, attempt)
            )
            attempt += 1

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
    ) -> Any:
        return _base.parse_ok(await self._send(method, path, json=json, params=params))

    async def create(
        self,
        *,
        timeout: int | None = None,
        idle_timeout: int | None = None,
        stop_on_disconnect: bool | None = None,
        viewport: Viewport | Mapping[str, int] | None = None,
        network: NetworkPolicy | Mapping[str, Any] | None = None,
        metadata: Mapping[str, str] | None = None,
        recording: bool | None = None,
        proxy: ProxyConfig | Mapping[str, Any] | None = None,
        timezone: str | None = None,
        wait_for_capacity_ms: int | None = None,
        idempotency_key: str | None = None,
    ) -> Session:
        body = _base.create_body(
            timeout=timeout,
            idle_timeout=idle_timeout,
            stop_on_disconnect=stop_on_disconnect,
            viewport=viewport,
            network=network,
            metadata=metadata,
            recording=recording,
            proxy=proxy,
            timezone=timezone,
            wait_for_capacity_ms=wait_for_capacity_ms,
            idempotency_key=idempotency_key,
        )
        return Session.from_dict(await self._request("POST", "v1/sessions", json=body))

    async def get(self, session_id: str) -> Session:
        return Session.from_dict(await self._request("GET", _base.session_path(session_id)))

    async def list(
        self,
        *,
        status: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> Page[Session]:
        r = await self._request(
            "GET",
            "v1/sessions",
            params=_base.query(status=status, limit=limit, cursor=cursor),
        )
        return Page([Session.from_dict(s) for s in r["data"]], r.get("nextCursor"))

    async def stop(self, session_id: str) -> Session:
        return Session.from_dict(
            await self._request("POST", _base.session_path(session_id, "/stop"))
        )

    async def events(
        self, session_id: str, *, limit: int | None = None, cursor: str | None = None
    ) -> Page[SessionEvent]:
        r = await self._request(
            "GET",
            _base.session_path(session_id, "/events"),
            params=_base.query(limit=limit, cursor=cursor),
        )
        return Page([SessionEvent.from_dict(e) for e in r["data"]], r.get("nextCursor"))

    async def iter_events(
        self, session_id: str, *, follow: bool = False, poll_interval: float = 1.0
    ) -> AsyncIterator[SessionEvent]:
        cursor: str | None = None
        seen: set[str] = set()
        ended = False
        while True:
            page = await self.events(session_id, limit=1000, cursor=cursor)
            for e in page.data:
                if e.id in seen:
                    continue
                seen.add(e.id)
                if e.type == "session.ended":
                    ended = True
                yield e
            if page.next_cursor:
                cursor, seen = page.next_cursor, set()
                continue
            if not follow or ended:
                return
            await _sleep(poll_interval)

    async def wait_until_ready(
        self, session_id: str, *, timeout: float = 60.0, poll_interval: float = 0.5
    ) -> Session:
        until = time.monotonic() + timeout
        while True:
            s = await self.get(session_id)
            if s.status in ("ready", "active"):
                return s
            if s.status in TERMINAL_STATUSES:
                raise SessionEndedError(s)
            if time.monotonic() >= until:
                raise KestrelError(f"session {session_id} is still {s.status} after {timeout} s")
            await _sleep(poll_interval)

    async def mint_token(
        self,
        session_id: str,
        scope: TokenScope,
        *,
        ttl_ms: int | None = None,
        single_use: bool | None = None,
    ) -> SessionToken:
        return SessionToken.from_dict(
            await self._request(
                "POST",
                _base.session_path(session_id, "/tokens"),
                json=_base.mint_body(scope, ttl_ms, single_use),
            )
        )

    async def live_view_url(
        self,
        session_id: str,
        *,
        control: bool = False,
        ttl_ms: int | None = None,
        single_use: bool | None = None,
    ) -> str:
        scope: TokenScope = "control" if control else "view"
        token = await self.mint_token(session_id, scope, ttl_ms=ttl_ms, single_use=single_use)
        return token.url

    async def computer(
        self,
        session_id: str,
        action: ComputerActionName,
        *,
        x: int | None = None,
        y: int | None = None,
        button: str | None = None,
        clicks: int | None = None,
        dx: int | None = None,
        dy: int | None = None,
        text: str | None = None,
        key: str | None = None,
        screenshot: bool | None = None,
    ) -> ComputerResponse:
        body = _base.computer_body(
            action,
            x=x,
            y=y,
            button=button,
            clicks=clicks,
            dx=dx,
            dy=dy,
            text=text,
            key=key,
            screenshot=screenshot,
        )
        return ComputerResponse.from_dict(
            await self._request("POST", _base.session_path(session_id, "/computer"), json=body)
        )

    async def iter_recording(
        self, session_id: str, *, chunk_size: int = 64 * 1024
    ) -> AsyncIterator[bytes]:
        response = await self._send(
            "GET", _base.session_path(session_id, "/recording"), stream=True
        )
        try:
            async for chunk in response.aiter_bytes(chunk_size):
                yield chunk
        finally:
            await response.aclose()

    async def recording(self, session_id: str) -> bytes:
        return b"".join([c async for c in self.iter_recording(session_id)])

    async def save_recording(self, session_id: str, path: str | os.PathLike[str]) -> int:
        """See ``Sessions.save_recording``. The writes are local and small, so they are made
        directly rather than in a thread."""
        target = Path(path)
        partial = target.with_name(target.name + ".part")
        size = 0
        try:
            with partial.open("wb") as f:
                async for chunk in self.iter_recording(session_id):
                    f.write(chunk)
                    size += len(chunk)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        return size


class AsyncKestrelBrowser:
    """A Playwright browser attached to a new session. ``await close()`` closes the browser
    and stops the session; it is also what leaving an ``async with`` block does."""

    def __init__(self, browser: Any, session: Session, playwright: Any, sessions: AsyncSessions):
        self.browser = browser
        self.session = session
        self._playwright = playwright
        self._sessions = sessions
        self._closed = False

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            await self.browser.close()
        with contextlib.suppress(Exception):
            await self._playwright.stop()
        await self._sessions.stop(self.session.id)

    async def __aenter__(self) -> AsyncKestrelBrowser:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()


class AsyncKestrel:
    """The Kestrel API client for asyncio. Arguments as for ``Kestrel``."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        timeout: float = 120.0,
        max_retries: int = 3,
        retry_base_delay: float = 0.5,
    ) -> None:
        self._config = _base.make_config(api_key, base_url, timeout, max_retries, retry_base_delay)
        self._http = httpx.AsyncClient(**_base.client_kwargs(self._config))
        self.sessions = AsyncSessions(self._http, self._config)

    @property
    def base_url(self) -> str:
        return self._config.base_url

    async def connect(self, *, connect_timeout: float = 30.0, **create: Any) -> AsyncKestrelBrowser:
        """See ``Kestrel.connect``."""
        try:
            from playwright.async_api import async_playwright
        except ImportError as e:
            raise KestrelError(
                "connect() needs Playwright: pip install 'kestrel-sdk[playwright]'"
            ) from e
        session = await self.sessions.create(**create)
        playwright = None
        try:
            if not session.connect_url:
                raise KestrelError(
                    f"session {session.id} is {session.status} and has no connect_url"
                )
            playwright = await async_playwright().start()
            browser = await playwright.chromium.connect_over_cdp(
                session.connect_url, timeout=connect_timeout * 1000
            )
        except BaseException:
            if playwright is not None:
                with contextlib.suppress(Exception):
                    await playwright.stop()
            with contextlib.suppress(Exception):
                await self.sessions.stop(session.id)
            raise
        return AsyncKestrelBrowser(browser, session, playwright, self.sessions)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncKestrel:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()
