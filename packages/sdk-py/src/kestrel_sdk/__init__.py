"""Python client for Kestrel, open-source cloud browsers for AI agents.

>>> from kestrel_sdk import Kestrel
>>> kestrel = Kestrel()  # KESTREL_API_KEY, KESTREL_URL
>>> session = kestrel.sessions.create(timeout=60_000)
>>> session.connect_url  # give this to Playwright or Puppeteer
"""

from ._async import AsyncKestrel, AsyncKestrelBrowser, AsyncSessions
from ._base import DEFAULT_BASE_URL, SDK_VERSION
from ._errors import ApiError, KestrelConnectionError, KestrelError, SessionEndedError
from ._sync import Kestrel, KestrelBrowser, Sessions
from ._types import (
    SESSION_STATUSES,
    TERMINAL_STATUSES,
    EndReason,
    ErrorCode,
    EventType,
    NetworkPolicy,
    Page,
    Session,
    SessionEvent,
    SessionOptions,
    SessionStatus,
    Usage,
    Viewport,
)

__version__ = SDK_VERSION

__all__ = [
    "DEFAULT_BASE_URL",
    "SESSION_STATUSES",
    "TERMINAL_STATUSES",
    "ApiError",
    "AsyncKestrel",
    "AsyncKestrelBrowser",
    "AsyncSessions",
    "EndReason",
    "ErrorCode",
    "EventType",
    "Kestrel",
    "KestrelBrowser",
    "KestrelConnectionError",
    "KestrelError",
    "NetworkPolicy",
    "Page",
    "Session",
    "SessionEndedError",
    "SessionEvent",
    "SessionOptions",
    "SessionStatus",
    "Sessions",
    "Usage",
    "Viewport",
]
