"""The SDK's types against the published API description, ``docs/api/openapi.json``.

The TypeScript SDK checks the same thing at compile time against the zod contracts; here the
generated OpenAPI document is the source, since it is what the Python side can read. A schema
that gains a field or an enum value fails one of these until it is copied into the SDK.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
import re
from pathlib import Path
from typing import Any, get_args

import pytest

from kestrel_sdk import (
    ApiError,
    AsyncSessions,
    ComputerActionName,
    ComputerResponse,
    NetworkPolicy,
    Session,
    SessionEvent,
    SessionOptions,
    Sessions,
    SessionToken,
    TokenScope,
    Usage,
    Viewport,
)
from kestrel_sdk._types import (
    SESSION_STATUSES,
    TERMINAL_STATUSES,
    EndReason,
    ErrorCode,
    EventType,
)

OPENAPI = Path(__file__).resolve().parents[3] / "docs" / "api" / "openapi.json"
SCHEMAS: dict[str, Any] = json.loads(OPENAPI.read_text())["components"]["schemas"]


def snake(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()


def props(schema: dict[str, Any]) -> set[str]:
    return {snake(p) for p in schema["properties"]}


def fields(cls: type) -> set[str]:
    return {f.name for f in dataclasses.fields(cls)} - {"raw"}


def enum(schema: dict[str, Any]) -> set[str]:
    if "anyOf" in schema:  # nullable
        schema = next(s for s in schema["anyOf"] if s.get("type") != "null")
    return set(schema["enum"])


def params(fn: Any, *skip: str) -> set[str]:
    return {p for p in inspect.signature(fn).parameters if p not in ("self", *skip)}


@pytest.mark.parametrize(
    "cls, schema",
    [
        (Session, SCHEMAS["Session"]),
        (SessionOptions, SCHEMAS["SessionOptions"]),
        (Viewport, SCHEMAS["Viewport"]),
        (NetworkPolicy, SCHEMAS["NetworkPolicy"]),
        (Usage, SCHEMAS["Session"]["properties"]["usage"]),
        (SessionToken, SCHEMAS["SessionToken"]),
        (ComputerResponse, SCHEMAS["ComputerResponse"]),
    ],
    ids=lambda x: getattr(x, "__name__", ""),
)
def test_dataclass_fields_match_the_schema(cls: type, schema: dict[str, Any]) -> None:
    assert fields(cls) == props(schema)


def test_event_fields_match_every_event_schema() -> None:
    for variant in SCHEMAS["SessionEvent"]["oneOf"]:
        assert fields(SessionEvent) == props(variant)


def test_event_types() -> None:
    types = {v["properties"]["type"]["const"] for v in SCHEMAS["SessionEvent"]["oneOf"]}
    assert set(get_args(EventType)) == types


def test_enums() -> None:
    session = SCHEMAS["Session"]["properties"]
    assert set(SESSION_STATUSES) == enum(session["status"])
    assert set(get_args(EndReason)) == enum(session["endReason"])
    assert set(get_args(ErrorCode)) == enum(SCHEMAS["Error"]["properties"]["code"])
    assert TERMINAL_STATUSES <= set(SESSION_STATUSES)


@pytest.mark.parametrize("resource", [Sessions, AsyncSessions])
def test_method_arguments_match_the_requests(resource: type) -> None:
    assert params(resource.create) == props(SCHEMAS["CreateSessionRequest"])
    assert params(resource.list) == props(SCHEMAS["ListSessionsQuery"])
    assert params(resource.events, "session_id") == props(SCHEMAS["ListEventsQuery"])


def test_api_error_carries_every_error_field() -> None:
    e = ApiError(500, "internal", "m", True, "req", "p")
    for name in props(SCHEMAS["Error"]):
        assert hasattr(e, name), name


def test_token_scopes_and_computer_actions() -> None:
    assert set(get_args(TokenScope)) == enum(SCHEMAS["MintTokenRequest"]["properties"]["scope"])
    actions = {v["properties"]["action"]["const"] for v in SCHEMAS["ComputerRequest"]["oneOf"]}
    assert set(get_args(ComputerActionName)) == actions


@pytest.mark.parametrize("resource", [Sessions, AsyncSessions])
def test_token_and_computer_arguments_match_the_requests(resource: type) -> None:
    assert params(resource.mint_token, "session_id") == props(SCHEMAS["MintTokenRequest"])
    every_action_field = set().union(*(props(v) for v in SCHEMAS["ComputerRequest"]["oneOf"]))
    assert params(resource.computer, "session_id") == every_action_field
