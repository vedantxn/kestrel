from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
import respx

from kestrel_browser import _async, _sync

BASE = "http://api.test"
SESSION_ID = "ses_01k6e4m9t8f2xq3w5y7z9a1b2c"
CONNECT_URL = f"wss://kestrel.test:443/v1/sessions/{SESSION_ID}/cdp?token=secret-token"

RETRYABLE = {"quota_exceeded", "capacity_exhausted", "conflict", "internal"}


def session_json(**overrides: Any) -> dict[str, Any]:
    """A session as the API sends it (camelCase)."""
    s: dict[str, Any] = {
        "id": SESSION_ID,
        "status": "ready",
        "endReason": None,
        "createdAt": "2026-10-03T10:00:00.000Z",
        "readyAt": "2026-10-03T10:00:01.200Z",
        "endedAt": None,
        "connectUrl": CONNECT_URL,
        "viewport": {"width": 1280, "height": 720},
        "deviceScaleFactor": 1,
        "options": {
            "timeout": 900_000,
            "idleTimeout": 300_000,
            "stopOnDisconnect": False,
            "viewport": {"width": 1280, "height": 720},
            "network": {},
            "metadata": {},
        },
        "nodeId": "a",
        "startPath": "hot",
        "usage": {"browserSeconds": 0},
    }
    s.update(overrides)
    return s


def api_error(
    code: str, message: str = "nope", *, retryable: bool | None = None, param: str | None = None
) -> dict[str, Any]:
    e: dict[str, Any] = {
        "code": code,
        "message": message,
        "retryable": code in RETRYABLE if retryable is None else retryable,
        "requestId": "req-1",
    }
    if param:
        e["param"] = param
    return {"error": e}


def event_json(n: int, type: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": f"evt_{n}",
        "sessionId": SESSION_ID,
        "at": f"2026-10-03T10:00:0{n}.000Z",
        "type": type,
        "data": data or {},
    }


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KESTREL_API_KEY", "ksl_test")
    monkeypatch.setenv("KESTREL_URL", BASE)


@pytest.fixture(autouse=True)
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Every wait the clients would make, recorded instead of slept."""
    record: list[float] = []

    async def asleep(seconds: float) -> None:
        record.append(seconds)

    monkeypatch.setattr(_sync, "_sleep", record.append)
    monkeypatch.setattr(_async, "_sleep", asleep)
    return record


@pytest.fixture
def api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE, assert_all_called=False) as router:
        yield router
