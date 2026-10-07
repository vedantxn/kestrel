from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

import httpx

from . import _base
from ._errors import ApiError, KestrelConnectionError, KestrelError, SessionEndedError
from ._types import (
    TERMINAL_STATUSES,
    CaptchaOptions,
    ComputerActionName,
    ComputerResponse,
    NetworkPolicy,
    Page,
    Profile,
    ProxyConfig,
    Session,
    SessionEvent,
    SessionProfile,
    SessionToken,
    TokenScope,
    Viewport,
)

# Indirection so tests can skip real waits.
_sleep = time.sleep


class _Resource:
    def __init__(self, http: httpx.Client, config: _base.Config) -> None:
        self._http = http
        self._config = config

    def _send(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        stream: bool = False,
        idempotent: bool = True,
        retry: Callable[[ApiError], bool] | None = None,
    ) -> httpx.Response:
        """Send one call, retrying when the API says ``retryable`` or no answer came back.
        Almost every endpoint is safe to repeat: reads, an idempotent stop, session creates that
        carry an idempotency key, token mints and single page actions. A call that is not
        (``idempotent=False``) is retried only when the API itself answered ``retryable``,
        which means it changed nothing. ``retry`` may refuse a retry of a retryable error. With
        ``stream``, a successful answer is returned unread and the caller closes it."""
        attempt = 0
        while True:
            request = self._http.build_request(method, path, json=json, params=params)
            try:
                response = self._http.send(request, stream=stream)
                if stream and not response.is_success:
                    response.read()
                    response.close()
            except httpx.TransportError as e:
                if not idempotent or attempt >= self._config.max_retries:
                    raise KestrelConnectionError(
                        f"{method} {self._config.base_url}{path} failed: {_base.describe(e)}"
                    ) from e
                _sleep(_base.backoff(self._config, attempt))
                attempt += 1
                continue
            if response.is_success:
                return response
            err = _base.to_api_error(response)
            if (
                not err.retryable
                or attempt >= self._config.max_retries
                or (not idempotent and err.code == "malformed_response")
                or (retry is not None and not retry(err))
            ):
                raise err
            _sleep(
                err.retry_after
                if err.retry_after is not None
                else _base.backoff(self._config, attempt)
            )
            attempt += 1

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        idempotent: bool = True,
        retry: Callable[[ApiError], bool] | None = None,
    ) -> Any:
        return _base.parse_ok(
            self._send(method, path, json=json, params=params, idempotent=idempotent, retry=retry)
        )


class Sessions(_Resource):
    """``/v1/sessions`` and everything under it. New per-session endpoints belong here."""

    def create(
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
        captcha: CaptchaOptions | Mapping[str, Any] | None = None,
        profile: SessionProfile | Mapping[str, Any] | None = None,
        wait_for_capacity_ms: int | None = None,
        idempotency_key: str | None = None,
        wait_for_profile_ms: int | None = None,
    ) -> Session:
        """Create a session. The API answers once the browser is ready to connect to.
        Durations are milliseconds.

        ``wait_for_profile_ms``: with ``profile={"id": ..., "persist": True}``, if another
        session is saving into the profile (a retryable ``409 conflict`` on ``profile.id``),
        keep trying for up to this long, with the client's backoff, before raising it. Without
        it that answer is raised at once, since a writer may hold a profile for hours."""
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
            captcha=captcha,
            profile=profile,
            wait_for_capacity_ms=wait_for_capacity_ms,
            idempotency_key=idempotency_key,
        )
        deadline = (
            None if wait_for_profile_ms is None else time.monotonic() + wait_for_profile_ms / 1000
        )
        attempt = 0
        while True:
            try:
                return Session.from_dict(
                    self._request(
                        "POST",
                        "v1/sessions",
                        json=body,
                        # A busy profile is retried here, and only when the caller asked to wait.
                        retry=lambda e: not _base.is_profile_busy(e),
                    )
                )
            except ApiError as e:
                if deadline is None or not _base.is_profile_busy(e):
                    raise
                left = deadline - time.monotonic()
                if left <= 0:
                    raise
                # At the latest, a last attempt at the deadline.
                wait = e.retry_after
                if wait is None:
                    wait = _base.backoff(self._config, attempt)
                _sleep(min(wait, left))
                attempt += 1

    def get(self, session_id: str) -> Session:
        return Session.from_dict(self._request("GET", _base.session_path(session_id)))

    def list(
        self,
        *,
        status: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> Page[Session]:
        """Newest first. Pass ``next_cursor`` back as ``cursor`` for the next page."""
        r = self._request(
            "GET",
            "v1/sessions",
            params=_base.query(status=status, limit=limit, cursor=cursor),
        )
        return Page([Session.from_dict(s) for s in r["data"]], r.get("nextCursor"))

    def stop(self, session_id: str) -> Session:
        """Idempotent. Returns at once with the session ``stopping`` (or already ended)."""
        return Session.from_dict(self._request("POST", _base.session_path(session_id, "/stop")))

    def events(
        self, session_id: str, *, limit: int | None = None, cursor: str | None = None
    ) -> Page[SessionEvent]:
        """One page of a session's timeline, oldest first."""
        r = self._request(
            "GET",
            _base.session_path(session_id, "/events"),
            params=_base.query(limit=limit, cursor=cursor),
        )
        return Page([SessionEvent.from_dict(e) for e in r["data"]], r.get("nextCursor"))

    def iter_events(
        self, session_id: str, *, follow: bool = False, poll_interval: float = 1.0
    ) -> Iterator[SessionEvent]:
        """Every event of a session, oldest first; with ``follow``, keep polling until it ends.

        The API gives no cursor on the last page, so to poll for more this keeps the last
        cursor it was given and re-reads from there, skipping events it already yielded."""
        cursor: str | None = None
        seen: set[str] = set()
        ended = False
        while True:
            page = self.events(session_id, limit=1000, cursor=cursor)
            for e in page.data:
                if e.id in seen:
                    continue
                seen.add(e.id)
                if e.type == "session.ended":
                    ended = True
                yield e
            if page.next_cursor:
                # The next page starts after everything already seen.
                cursor, seen = page.next_cursor, set()
                continue
            if not follow or ended:
                return
            _sleep(poll_interval)

    def wait_until_ready(
        self, session_id: str, *, timeout: float = 60.0, poll_interval: float = 0.5
    ) -> Session:
        """Poll until the session can be connected to (``ready`` or ``active``). Raises
        ``SessionEndedError`` if it ends first. ``create`` already waits for this; use it for
        a session created elsewhere. ``timeout`` is in seconds."""
        until = time.monotonic() + timeout
        while True:
            s = self.get(session_id)
            if s.status in ("ready", "active"):
                return s
            if s.status in TERMINAL_STATUSES:
                raise SessionEndedError(s)
            if time.monotonic() >= until:
                raise KestrelError(f"session {session_id} is still {s.status} after {timeout} s")
            _sleep(poll_interval)

    def mint_token(
        self,
        session_id: str,
        scope: TokenScope,
        *,
        ttl_ms: int | None = None,
        single_use: bool | None = None,
    ) -> SessionToken:
        """Mint a token for a running session: ``cdp`` re-issues a connect URL, ``view`` and
        ``control`` open live view (default 10 minutes, at most 1 hour). ``single_use`` tokens
        open one connection."""
        return SessionToken.from_dict(
            self._request(
                "POST",
                _base.session_path(session_id, "/tokens"),
                json=_base.mint_body(scope, ttl_ms, single_use),
            )
        )

    def live_view_url(
        self,
        session_id: str,
        *,
        control: bool = False,
        ttl_ms: int | None = None,
        single_use: bool | None = None,
    ) -> str:
        """The URL of a page that shows the browser live; with ``control`` a person can drive
        it too. The URL holds a token: share it only with whoever should watch."""
        scope: TokenScope = "control" if control else "view"
        return self.mint_token(session_id, scope, ttl_ms=ttl_ms, single_use=single_use).url

    def computer(
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
        """One action on the session's current page, no CDP client needed: ``screenshot``;
        ``click`` (x, y, button, clicks); ``move`` (x, y); ``scroll`` (x, y, dx, dy);
        ``type`` (text); ``key`` (key, a DOM key name such as ``Enter``). Any action but
        ``screenshot`` may pass ``screenshot=True`` to get the page afterwards."""
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
            self._request("POST", _base.session_path(session_id, "/computer"), json=body)
        )

    def iter_recording(self, session_id: str, *, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
        """The session's video (fragmented MP4) in chunks, for a session created with
        ``recording=True``. While the session runs it ends at the latest fragment."""
        response = self._send("GET", _base.session_path(session_id, "/recording"), stream=True)
        try:
            yield from response.iter_bytes(chunk_size)
        finally:
            response.close()

    def recording(self, session_id: str) -> bytes:
        """The whole video at once. For a long session prefer ``save_recording``."""
        return b"".join(self.iter_recording(session_id))

    def save_recording(self, session_id: str, path: str | os.PathLike[str]) -> int:
        """Download the video to ``path`` and return its size in bytes. It is written beside
        ``path`` first and renamed when complete, so a failed download leaves no partial
        file under the name asked for."""
        target = Path(path)
        partial = target.with_name(target.name + ".part")
        size = 0
        try:
            with partial.open("wb") as f:
                for chunk in self.iter_recording(session_id):
                    f.write(chunk)
                    size += len(chunk)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        return size


class Profiles(_Resource):
    """``/v1/profiles``: saved browser state (cookies, ``localStorage`` and IndexedDB of the
    default context) that sessions start from with ``profile={"id": ...}`` and save into with
    ``profile={"id": ..., "persist": True}``. Every call raises ``400 invalid_request`` on a
    deployment whose operator has not configured profiles."""

    def create(
        self, *, name: str | None = None, metadata: Mapping[str, str] | None = None
    ) -> Profile:
        """Create an empty profile (``version`` 0). There is no idempotency key for this call,
        so it is sent again only when the API answered that it changed nothing; a create that
        got no answer is not repeated, since it may have made the profile."""
        body = _base.query(name=name, metadata=dict(metadata) if metadata is not None else None)
        return Profile.from_dict(self._request("POST", "v1/profiles", json=body, idempotent=False))

    def get(self, profile_id: str) -> Profile:
        return Profile.from_dict(self._request("GET", _base.profile_path(profile_id)))

    def list(self, *, limit: int | None = None, cursor: str | None = None) -> Page[Profile]:
        """Newest first. Pass ``next_cursor`` back as ``cursor`` for the next page."""
        r = self._request("GET", "v1/profiles", params=_base.query(limit=limit, cursor=cursor))
        return Page([Profile.from_dict(p) for p in r["data"]], r.get("nextCursor"))

    def delete(self, profile_id: str) -> None:
        """Delete a profile and every saved version of it. Sessions already running keep their
        browsers; a session saving into it saves nothing. Deleting it again is ``not_found``."""
        self._send("DELETE", _base.profile_path(profile_id))


class KestrelBrowser:
    """A Playwright browser attached to a new session. ``close()`` closes the browser and
    stops the session; it is also what leaving a ``with`` block does."""

    def __init__(self, browser: Any, session: Session, playwright: Any, sessions: Sessions):
        self.browser = browser
        self.session = session
        self._playwright = playwright
        self._sessions = sessions
        self._closed = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        # The socket may already be gone (the session timed out, or the browser crashed);
        # the session still needs stopping either way.
        with contextlib.suppress(Exception):
            self.browser.close()
        with contextlib.suppress(Exception):
            self._playwright.stop()
        self._sessions.stop(self.session.id)

    def __enter__(self) -> KestrelBrowser:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class Kestrel:
    """The Kestrel API client.

    >>> with Kestrel() as kestrel, kestrel.connect() as k:
    ...     page = k.browser.contexts[0].pages[0]
    ...     page.goto("https://example.com")
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        timeout: float = 120.0,
        max_retries: int = 3,
        retry_base_delay: float = 0.5,
    ) -> None:
        """``api_key`` defaults to ``KESTREL_API_KEY``; ``base_url`` to ``KESTREL_URL``, then
        ``http://localhost:8080``. ``timeout`` (seconds, per attempt) is longer than a create
        that waits for capacity."""
        self._config = _base.make_config(api_key, base_url, timeout, max_retries, retry_base_delay)
        self._http = httpx.Client(**_base.client_kwargs(self._config))
        self.sessions = Sessions(self._http, self._config)
        self.profiles = Profiles(self._http, self._config)

    @property
    def base_url(self) -> str:
        return self._config.base_url

    def connect(self, *, connect_timeout: float = 30.0, **create: Any) -> KestrelBrowser:
        """Create a session (``create`` takes the same arguments as ``sessions.create``) and
        attach Playwright to it. Needs ``pip install 'kestrel-sdk[playwright]'``.

        If attaching fails the session is stopped before the error is raised, so a failed
        connect never leaves a browser running until its idle timeout."""
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise KestrelError(
                "connect() needs Playwright: pip install 'kestrel-sdk[playwright]'"
            ) from e
        session = self.sessions.create(**create)
        playwright = None
        try:
            if not session.connect_url:
                raise KestrelError(
                    f"session {session.id} is {session.status} and has no connect_url"
                )
            playwright = sync_playwright().start()
            browser = playwright.chromium.connect_over_cdp(
                session.connect_url, timeout=connect_timeout * 1000
            )
        except BaseException:
            if playwright is not None:
                with contextlib.suppress(Exception):
                    playwright.stop()
            with contextlib.suppress(Exception):
                self.sessions.stop(session.id)
            raise
        return KestrelBrowser(browser, session, playwright, self.sessions)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Kestrel:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
