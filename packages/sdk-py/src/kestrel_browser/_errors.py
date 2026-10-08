from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._types import Session


class KestrelError(Exception):
    """The base of every error the SDK raises on purpose, so callers can catch them as one."""


class ApiError(KestrelError):
    """An error answer from the API.

    ``code`` is the API's stable code (or ``malformed_response`` when the body was not the
    documented error shape); ``message`` is for people and may change.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        retryable: bool,
        request_id: str | None = None,
        param: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.request_id = request_id
        self.param = param
        # Seconds, from the Retry-After header, when the API sent one.
        self.retry_after = retry_after


class KestrelConnectionError(KestrelError):
    """The request never got an answer: refused, reset, or past the client's timeout."""


class SessionEndedError(KestrelError):
    """A session ended while the caller was waiting for it to become ready."""

    def __init__(self, session: Session) -> None:
        super().__init__(
            f"session {session.id} ended ({session.status}, "
            f"{session.end_reason or 'no reason'}) before it was ready"
        )
        self.session = session
