"""What the sync and async clients share: configuration, request bodies, error mapping and
the retry rule. Only the waiting and the I/O differ between them."""

from __future__ import annotations

import os
import random
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote

import httpx

from ._errors import ApiError, KestrelError
from ._types import CaptchaOptions, NetworkPolicy, ProxyConfig, SessionProfile, Viewport

SDK_VERSION = "0.1.0"
DEFAULT_BASE_URL = "http://localhost:8080"
# The longest exponential backoff step; a Retry-After from the API may ask for longer.
MAX_BACKOFF = 8.0


@dataclass(frozen=True)
class Config:
    api_key: str
    base_url: str
    timeout: float
    max_retries: int
    retry_base_delay: float


def make_config(
    api_key: str | None,
    base_url: str | None,
    timeout: float,
    max_retries: int,
    retry_base_delay: float,
) -> Config:
    key = api_key or os.environ.get("KESTREL_API_KEY")
    if not key:
        raise KestrelError("No API key: pass api_key= or set KESTREL_API_KEY")
    # Paths are joined relative to the base, so a base with a path prefix keeps it.
    base = base_url or os.environ.get("KESTREL_URL") or DEFAULT_BASE_URL
    if not base.endswith("/"):
        base += "/"
    return Config(key, base, timeout, max_retries, retry_base_delay)


def client_kwargs(config: Config) -> dict[str, Any]:
    return {
        "base_url": config.base_url,
        "timeout": config.timeout,
        "headers": {
            "authorization": f"Bearer {config.api_key}",
            "user-agent": f"kestrel-sdk-py/{SDK_VERSION}",
            "accept": "application/json",
        },
    }


def session_path(session_id: str, suffix: str = "") -> str:
    return f"v1/sessions/{quote(session_id, safe='')}{suffix}"


def create_body(
    *,
    timeout: int | None,
    idle_timeout: int | None,
    stop_on_disconnect: bool | None,
    viewport: Viewport | Mapping[str, int] | None,
    network: NetworkPolicy | Mapping[str, Any] | None,
    metadata: Mapping[str, str] | None,
    recording: bool | None,
    proxy: ProxyConfig | Mapping[str, Any] | None,
    timezone: str | None,
    captcha: CaptchaOptions | Mapping[str, Any] | None,
    profile: SessionProfile | Mapping[str, Any] | None,
    wait_for_capacity_ms: int | None,
    idempotency_key: str | None,
) -> dict[str, Any]:
    """The JSON body of a create. Every create carries an idempotency key, made up here unless
    the caller passes one, so a retry after a lost answer returns the same session instead of
    starting a second browser."""
    body: dict[str, Any] = {
        "timeout": timeout,
        "idleTimeout": idle_timeout,
        "stopOnDisconnect": stop_on_disconnect,
        "viewport": viewport.to_dict() if isinstance(viewport, Viewport) else viewport,
        "network": network.to_dict() if isinstance(network, NetworkPolicy) else network,
        "metadata": dict(metadata) if metadata is not None else None,
        "recording": recording,
        "proxy": proxy.to_dict() if isinstance(proxy, ProxyConfig) else proxy,
        "timezone": timezone,
        "captcha": captcha.to_dict() if isinstance(captcha, CaptchaOptions) else captcha,
        "profile": profile.to_dict() if isinstance(profile, SessionProfile) else profile,
        "waitForCapacityMs": wait_for_capacity_ms,
        "idempotencyKey": idempotency_key or str(uuid.uuid4()),
    }
    return {k: v for k, v in body.items() if v is not None}


def mint_body(scope: str, ttl_ms: int | None, single_use: bool | None) -> dict[str, Any]:
    return query(scope=scope, ttlMs=ttl_ms, singleUse=single_use)


def computer_body(action: str, **fields: Any) -> dict[str, Any]:
    """One /computer action. Every field name is one word, so it is the same in JSON."""
    return {"action": action, **query(**fields)}


def query(**params: Any) -> dict[str, Any]:
    return {k: v for k, v in params.items() if v is not None}


def parse_ok(response: httpx.Response) -> Any:
    try:
        return response.json() if response.content else None
    except ValueError:
        raise malformed(response) from None


def to_api_error(response: httpx.Response) -> ApiError:
    try:
        e = response.json().get("error")
    except (ValueError, AttributeError):
        return malformed(response)
    if (
        not isinstance(e, dict)
        or not isinstance(e.get("code"), str)
        or not isinstance(e.get("message"), str)
        or not isinstance(e.get("retryable"), bool)
    ):
        return malformed(response)
    return ApiError(
        status=response.status_code,
        code=e["code"],
        message=e["message"],
        retryable=e["retryable"],
        request_id=e.get("requestId") if isinstance(e.get("requestId"), str) else None,
        param=e.get("param") if isinstance(e.get("param"), str) else None,
        retry_after=retry_after(response.headers.get("retry-after")),
    )


def malformed(response: httpx.Response) -> ApiError:
    """Not the documented shape: something between us and the API (a proxy, a load
    balancer) answered. A 502/503/504 from one of those is worth retrying; nothing else is."""
    return ApiError(
        status=response.status_code,
        code="malformed_response",
        message=response.text[:200] or response.reason_phrase,
        retryable=response.status_code in (502, 503, 504),
        retry_after=retry_after(response.headers.get("retry-after")),
    )


def retry_after(header: str | None) -> float | None:
    """Seconds to wait. ``Retry-After`` is either whole seconds or an HTTP date."""
    if not header:
        return None
    try:
        seconds = float(header)
        return seconds if seconds >= 0 else None
    except ValueError:
        pass
    try:
        at = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    return max(0.0, (at - datetime.now(timezone.utc)).total_seconds())


def backoff(config: Config, attempt: int) -> float:
    """Exponential backoff with full jitter, so many clients told "full" do not return
    together."""
    return random.random() * min(MAX_BACKOFF, config.retry_base_delay * 2**attempt)


def describe(e: Exception) -> str:
    return str(e) or type(e).__name__
