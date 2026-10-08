"""The public API's types as dataclasses with snake_case attributes.

They mirror the schemas in ``docs/api/openapi.json``; ``tests/test_parity.py`` fails when a
schema gains a field or an enum value that is not copied here. Parsing ignores unknown
fields, so a newer server does not break an older client, and every object keeps the dict
it was built from on ``.raw``. Durations are milliseconds, as in the API.
"""

from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Generic, Literal, TypeVar, get_args

SessionStatus = Literal[
    "requested",
    "scheduling",
    "starting",
    "ready",
    "active",
    "stopping",
    "stopped",
    "failed",
    "timed_out",
]

# A session in one of these has ended and never changes again.
TERMINAL_STATUSES: frozenset[str] = frozenset({"stopped", "failed", "timed_out"})

EndReason = Literal[
    "client_stop",
    "client_disconnect",
    "idle_timeout",
    "max_lifetime",
    "browser_crash",
    "oom",
    "runtime_crash",
    "node_lost",
    "start_timeout",
    "disk_limit",
    "node_refused",
    "profile_unavailable",
]

# A newer server may send event types not listed here; they are passed through as they are.
EventType = Literal[
    "session.requested",
    "session.scheduled",
    "session.starting",
    "session.ready",
    "session.attached",
    "session.detached",
    "session.stopping",
    "session.ended",
    "egress.denied",
    "runtime.crashed",
    "node.lost",
    "captcha.detected",
    "captcha.cleared",
    "captcha.solving",
    "captcha.solved",
    "captcha.failed",
    "profile.restored",
    "profile.saved",
    "profile.save_failed",
]

EgressDenyReason = Literal[
    "blocked_address",
    "port_not_allowed",
    "not_in_allow_list",
    "in_deny_list",
    "resolve_failed",
    "connection_cap",
    "no_policy",
    "upstream_blocked",
    "upstream_unreachable",
    "upstream_auth_failed",
    "upstream_refused",
    "upstream_tls_failed",
]

CaptchaProvider = Literal[
    "recaptcha",
    "hcaptcha",
    "turnstile",
    "cloudflare_challenge",
    "arkose",
    "datadome",
    "perimeterx",
    "geetest",
    "aws_waf",
]

# Why a solve did not put a token in the page: hand the CAPTCHA to a person.
CaptchaSolveFailure = Literal[
    "unsupported",
    "no_details",
    "solver_error",
    "solver_unreachable",
    "timeout",
    "inject_failed",
    "budget",
    "no_solver",
    "runtime_unsupported",
]

# `cdp` re-issues a connect URL; `view` opens live view; `control` opens it with input.
TokenScope = Literal["cdp", "view", "control"]

ComputerActionName = Literal["screenshot", "click", "move", "scroll", "type", "key"]

ErrorCode = Literal[
    "unauthorized",
    "not_found",
    "invalid_request",
    "quota_exceeded",
    "capacity_exhausted",
    "conflict",
    "internal",
]

SESSION_STATUSES: tuple[str, ...] = get_args(SessionStatus)


def _time(value: str | None) -> datetime | None:
    # Python 3.10's fromisoformat does not accept a trailing "Z".
    return None if value is None else datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass(frozen=True)
class Viewport:
    """The page's inner size in CSS pixels."""

    width: int
    height: int

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Viewport:
        return cls(width=d["width"], height=d["height"])

    def to_dict(self) -> dict[str, Any]:
        return {"width": self.width, "height": self.height}


@dataclass(frozen=True)
class NetworkPolicy:
    """``allow``: if set, only these hostnames may be reached. ``deny``: these are refused."""

    allow: list[str] | None = None
    deny: list[str] | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> NetworkPolicy:
        return cls(allow=d.get("allow"), deny=d.get("deny"))

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.allow is not None:
            out["allow"] = list(self.allow)
        if self.deny is not None:
            out["deny"] = list(self.deny)
        return out


ProxyProvider = Literal["generic", "brightdata", "oxylabs", "decodo", "iproyal"]

_EXIT_FIELDS = (
    ("provider", "provider"),
    ("country", "country"),
    ("region", "region"),
    ("city", "city"),
    ("sticky", "sticky"),
    ("sticky_minutes", "stickyMinutes"),
)


@dataclass(frozen=True)
class SessionProxy:
    """A session's upstream proxy as stored and returned: the username as given (before any
    provider adapter) and the exit asked for. The password is never returned."""

    server: str
    username: str | None = None
    provider: ProxyProvider | None = None
    country: str | None = None
    region: str | None = None
    city: str | None = None
    sticky: str | None = None
    sticky_minutes: int | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> SessionProxy:
        return cls(
            server=d["server"],
            username=d.get("username"),
            **{py: d.get(js) for py, js in _EXIT_FIELDS},
        )


@dataclass(frozen=True)
class ProxyConfig:
    """Send a session's traffic through your own proxy: ``server`` is ``http://host:port``,
    ``https://host:port`` (TLS to the proxy) or ``socks5://host:port``. ``provider`` with
    ``country``, ``region``, ``city`` and ``sticky`` asks a residential provider for an exit
    in its own username format. The password is write-only (the API never stores or returns
    it) and is kept out of ``repr()``, so it stays out of logs."""

    server: str
    username: str | None = None
    password: str | None = field(default=None, repr=False)
    provider: ProxyProvider | None = None
    country: str | None = None
    region: str | None = None
    city: str | None = None
    sticky: str | None = None
    sticky_minutes: int | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"server": self.server}
        if self.username is not None:
            out["username"] = self.username
        if self.password is not None:
            out["password"] = self.password
        for py, js in _EXIT_FIELDS:
            if getattr(self, py) is not None:
                out[js] = getattr(self, py)
        return out


@dataclass(frozen=True)
class CaptchaOptions:
    """``solve=True`` sends reCAPTCHA, hCaptcha and Turnstile widgets that show to the
    deployment's CAPTCHA solver service and puts the token into the page. Refused when the
    deployment has no solver. The page's URL (without query or fragment) and the widget's site
    key go to that third party, and the page can tell its callback was called by something other
    than the widget."""

    solve: bool = False

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> CaptchaOptions:
        return cls(solve=bool(d.get("solve", False)))

    def to_dict(self) -> dict[str, Any]:
        return {"solve": self.solve}


@dataclass(frozen=True)
class SessionProfile:
    """Start from a saved profile (cookies, ``localStorage`` and IndexedDB of the default
    context). With ``persist=True`` the session's state is saved back as the profile's next
    version when it ends cleanly; one session at a time may persist a profile."""

    id: str
    persist: bool = False

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> SessionProfile:
        return cls(id=d["id"], persist=bool(d.get("persist", False)))

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "persist": self.persist}


@dataclass(frozen=True)
class Profile:
    """Saved browser state that sessions start from (``profile={"id": ...}``). ``version`` is 0
    until a session has saved one; ``in_use_by`` is the session that will save the next version,
    if one is running. Only a Chrome of ``chrome_major`` or newer opens it."""

    id: str
    name: str | None
    metadata: dict[str, str]
    version: int
    bytes: int
    saved_at: datetime | None
    saved_by_session_id: str | None
    chrome_major: int | None
    in_use_by: str | None
    created_at: datetime
    raw: dict[str, Any] = field(repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Profile:
        return cls(
            id=d["id"],
            name=d.get("name"),
            metadata=dict(d.get("metadata") or {}),
            version=d["version"],
            bytes=d["bytes"],
            saved_at=_time(d.get("savedAt")),
            saved_by_session_id=d.get("savedBySessionId"),
            chrome_major=d.get("chromeMajor"),
            in_use_by=d.get("inUseBy"),
            created_at=_time(d["createdAt"]),  # type: ignore[arg-type]
            raw=dict(d),
        )


@dataclass(frozen=True)
class SessionOptions:
    """A session's options as the API applied them, defaults filled in."""

    timeout: int
    idle_timeout: int
    stop_on_disconnect: bool
    viewport: Viewport
    network: NetworkPolicy
    recording: bool
    metadata: dict[str, str]
    proxy: SessionProxy | None = None
    timezone: str | None = None
    captcha: CaptchaOptions = field(default_factory=CaptchaOptions)
    profile: SessionProfile | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> SessionOptions:
        return cls(
            timeout=d["timeout"],
            idle_timeout=d["idleTimeout"],
            stop_on_disconnect=d["stopOnDisconnect"],
            viewport=Viewport.from_dict(d["viewport"]),
            network=NetworkPolicy.from_dict(d.get("network") or {}),
            recording=bool(d.get("recording", False)),
            metadata=dict(d.get("metadata") or {}),
            proxy=SessionProxy.from_dict(d["proxy"]) if d.get("proxy") else None,
            timezone=d.get("timezone"),
            captcha=CaptchaOptions.from_dict(d.get("captcha") or {}),
            profile=SessionProfile.from_dict(d["profile"]) if d.get("profile") else None,
        )


@dataclass(frozen=True)
class Usage:
    """Filled in when the session ends. Bytes are counted at the egress gateway: ``up`` is
    what the browser sent, ``down`` what it received."""

    browser_seconds: float
    egress_bytes_up: int = 0
    egress_bytes_down: int = 0


@dataclass(frozen=True)
class CaptchaSolveState:
    """The latest solve of a CAPTCHA still present (sessions created with ``captcha.solve``).
    ``solved`` means a token was put into the page; the site may still refuse it. ``failed``:
    hand the CAPTCHA to a person."""

    provider: str
    status: str  # "solving" | "solved" | "failed"
    at: datetime
    reason: str | None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> CaptchaSolveState:
        return cls(
            provider=d["provider"],
            status=d["status"],
            at=_time(d["at"]),  # type: ignore[arg-type]
            reason=d.get("reason"),
        )


@dataclass(frozen=True)
class SessionCaptcha:
    """A CAPTCHA from a known provider is showing on a page. It may already be solved: a solved
    checkbox stays until the page moves on. Unless ``solve`` says it is solving or solved, hand
    a person a control live-view link."""

    providers: list[str]
    since: datetime
    solve: CaptchaSolveState | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> SessionCaptcha:
        return cls(
            providers=list(d["providers"]),
            since=_time(d["since"]),  # type: ignore[arg-type]
            solve=CaptchaSolveState.from_dict(d["solve"]) if d.get("solve") else None,
        )


@dataclass(frozen=True)
class Session:
    id: str
    status: str
    end_reason: str | None
    created_at: datetime
    ready_at: datetime | None
    ended_at: datetime | None
    # A wss:// URL for Playwright, Puppeteer or any CDP client. It embeds a token, so it is
    # kept out of repr() and therefore out of logs.
    connect_url: str | None = field(repr=False)
    viewport: Viewport
    device_scale_factor: float
    options: SessionOptions
    node_id: str | None
    start_path: str | None
    usage: Usage
    captcha: SessionCaptcha | None
    raw: dict[str, Any] = field(repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Session:
        return cls(
            id=d["id"],
            status=d["status"],
            end_reason=d.get("endReason"),
            created_at=_time(d["createdAt"]),  # type: ignore[arg-type]
            ready_at=_time(d.get("readyAt")),
            ended_at=_time(d.get("endedAt")),
            connect_url=d.get("connectUrl"),
            viewport=Viewport.from_dict(d["viewport"]),
            device_scale_factor=d["deviceScaleFactor"],
            options=SessionOptions.from_dict(d["options"]),
            node_id=d.get("nodeId"),
            start_path=d.get("startPath"),
            usage=Usage(
                browser_seconds=d["usage"]["browserSeconds"],
                egress_bytes_up=d["usage"].get("egressBytesUp", 0),
                egress_bytes_down=d["usage"].get("egressBytesDown", 0),
            ),
            captcha=SessionCaptcha.from_dict(d["captcha"]) if d.get("captcha") else None,
            raw=dict(d),
        )

    @property
    def ended(self) -> bool:
        return self.status in TERMINAL_STATUSES


@dataclass(frozen=True)
class SessionEvent:
    """One entry in a session's timeline. ``data`` is the event's payload as the API sent it."""

    id: str
    session_id: str
    at: datetime
    type: str
    data: dict[str, Any]
    raw: dict[str, Any] = field(repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> SessionEvent:
        return cls(
            id=d["id"],
            session_id=d["sessionId"],
            at=_time(d["at"]),  # type: ignore[arg-type]
            type=d["type"],
            data=dict(d.get("data") or {}),
            raw=dict(d),
        )


T = TypeVar("T")


@dataclass(frozen=True)
class Page(Generic[T]):
    """One page of a list. ``next_cursor`` is None on the last page."""

    data: list[T]
    next_cursor: str | None


@dataclass(frozen=True)
class SessionToken:
    """A minted token. ``url`` is ready to use: the connect URL for ``cdp``, the viewer page
    (token in its fragment) for ``view`` and ``control``. Both are secrets, so kept out of
    repr()."""

    scope: str
    token: str = field(repr=False)
    url: str = field(repr=False)
    expires_at: datetime
    raw: dict[str, Any] = field(repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> SessionToken:
        return cls(
            scope=d["scope"],
            token=d["token"],
            url=d["url"],
            expires_at=_time(d["expiresAt"]),  # type: ignore[arg-type]
            raw=dict(d),
        )


@dataclass(frozen=True)
class ComputerResponse:
    """The page after a /computer action. Coordinates are CSS pixels of a ``width`` by
    ``height`` page. ``screenshot`` is a base64 PNG when one was taken."""

    ok: bool
    screenshot: str | None = field(repr=False)
    width: int
    height: int
    url: str
    raw: dict[str, Any] = field(repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> ComputerResponse:
        return cls(
            ok=d["ok"],
            screenshot=d.get("screenshot"),
            width=d["width"],
            height=d["height"],
            url=d["url"],
            raw=dict(d),
        )

    @property
    def screenshot_png(self) -> bytes | None:
        return None if self.screenshot is None else base64.b64decode(self.screenshot)
