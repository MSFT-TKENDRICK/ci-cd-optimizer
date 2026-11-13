"""Agent Lightning tracing: every agent episode becomes an AGL rollout with model, tool and reward events.

By default the tracer hosts Agent Lightning's own store API in-process (no network, no port). Set
AGL_SERVER_URL and AGL_KEY to stream the same rollouts to a shared Agent Lightning server instead. Each
event is also mirrored to a JSONL file so offline analysis never depends on the store's lifetime.

Agent Lightning invokes rollout hooks only from its verl trainer, so this tracer runs them itself after
each terminal transition, with the same (rollout, events_by_attempt, writer) contract.
"""
from __future__ import annotations

import json
import os
import secrets
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from agent_framework import ChatContext, ChatMiddleware
from agentlightning.hooks import RolloutHooks
from agentlightning.schemas import DEFAULT_ATTEMPT_ID, Event, Rollout

MAX_EVENT_TEXT = 4000
# Reasoning tokens are billed as output but reported separately, so a reasoning-effort change shows its cost.
USAGE_KEYS = ("input_token_count", "output_token_count", "reasoning_output_token_count")


def _clip(value: Any, limit: int = MAX_EVENT_TEXT) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + f"...[{len(value) - limit} chars clipped]"
    if isinstance(value, dict):
        return {k: _clip(v, limit) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clip(v, limit) for v in value]
    return value


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


class _BufferedWriter:
    """TraceWriter for hooks: buffers hook-emitted events so the tracer can post them asynchronously."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str, str, dict]] = []

    def add_event(self, rollout_id: str, attempt_id: str, event_type: str, data: dict[str, Any]) -> None:
        self.events.append((rollout_id, attempt_id, event_type, data))


class RewardHooks(RolloutHooks):
    """Guarantees every terminal rollout carries exactly one reward, as AGL trainers expect.

    Graders post explicit rewards (source="grader"). A succeeded rollout without one receives a 0.0
    fallback; a failed rollout (infrastructure or harness error) receives a 0.0 fallback with the reason,
    so failed attempts are visible as rework rather than silently dropped from averages.
    """

    def on_succeeded(self, rollout: Rollout, events: dict[str, list[Any]], store: Any) -> None:
        for attempt_id, items in events.items():
            if not any(getattr(e, "event_type", None) == "reward" for e in items):
                store.add_event(rollout.rollout_id, attempt_id, "reward",
                                {"value": 0.0, "source": "fallback", "reason": "no-grader-reward"})

    def on_failed(self, rollout: Rollout, store: Any) -> None:
        store.add_event(rollout.rollout_id, rollout.status.last_attempt_id or DEFAULT_ATTEMPT_ID, "reward",
                        {"value": 0.0, "source": "fallback", "reason": "rollout-failed",
                         "message": rollout.status.error_message})


@dataclass
class Episode:
    rollout_id: str
    input: dict
    attempt_id: str = DEFAULT_ATTEMPT_ID
    events: list[tuple[str, dict]] = field(default_factory=list)
    reward_value: float | None = None
    started: float = field(default_factory=time.perf_counter)

    def record(self, event_type: str, data: dict[str, Any]) -> None:
        """Synchronous so middleware callbacks can record without awaiting; flushed in order at close."""
        payload = _jsonable(_clip(dict(data)))
        payload.setdefault("t_ms", round((time.perf_counter() - self.started) * 1000, 1))
        self.events.append((event_type, payload))

    def reward(self, value: float, *, message: str | None = None, reason: str | None = None,
               source: str = "grader", **extra: Any) -> None:
        if self.reward_value is not None:
            raise RuntimeError("an episode carries exactly one reward")
        self.reward_value = float(value)
        self.record("reward", {"value": float(value), "message": message, "source": source, "reason": reason, **extra})

    @property
    def tool_calls(self) -> list[dict]:
        return [data for kind, data in self.events if kind == "tool_call"]

    @property
    def usage(self) -> dict[str, int]:
        totals = {**dict.fromkeys(USAGE_KEYS, 0), "requests": 0}
        for kind, data in self.events:
            if kind == "model_request":
                totals["requests"] += 1
                for key in USAGE_KEYS:
                    totals[key] += int((data.get("usage") or {}).get(key) or 0)
        return totals


class Tracer:
    """Async context manager owning the AGL client. Use ``async with tracer.episode(...) as ep``."""

    def __init__(self, *, jsonl: Path | None = None, url: str | None = None, key: str | None = None,
                 hooks: RolloutHooks | None = None, model_name: str = "unknown") -> None:
        self.url = url if url is not None else os.environ.get("AGL_SERVER_URL")
        self.key = key if key is not None else os.environ.get("AGL_KEY") or ""
        self.jsonl = jsonl
        self.hooks = hooks or RewardHooks()
        self.model_name = model_name
        self.client: httpx.AsyncClient | None = None
        self.rollouts: list[dict] = []

    async def __aenter__(self) -> "Tracer":
        if self.url:
            self.client = httpx.AsyncClient(base_url=self.url.rstrip("/"), timeout=30.0,
                                            headers={"Authorization": f"Bearer {self.key}"} if self.key else {})
        else:
            from agentlightning.server.app import create_app

            # A per-process random key keeps the in-process store authenticated like a real deployment.
            self.key = self.key or secrets.token_urlsafe(24)
            app = create_app({"key": self.key, "default_proxy": {"model_name": self.model_name},
                              "upstream_timeout_seconds": 60})
            self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agl.local",
                                            headers={"Authorization": f"Bearer {self.key}"})
        self.hooks.on_startup(None)
        if self.jsonl:
            self.jsonl.parent.mkdir(parents=True, exist_ok=True)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self.client:
            await self.client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        assert self.client is not None, "use Tracer as an async context manager"
        response = await self.client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else None

    async def _post_event(self, rollout_id: str, attempt_id: str, event_type: str, data: dict) -> None:
        await self._request("POST", f"/api/rollouts/{rollout_id}/attempt/{attempt_id}/events",
                            json={"event_type": event_type, "data": data})
        if self.jsonl:
            with self.jsonl.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"rollout_id": rollout_id, "attempt_id": attempt_id,
                                         "event_type": event_type, "data": data}, ensure_ascii=False) + "\n")

    async def events(self, rollout_id: str, event_type: str | None = None) -> list[dict]:
        params = {"event_type": event_type} if event_type else {}
        return await self._request("GET", f"/api/rollouts/{rollout_id}/events", params=params)

    @asynccontextmanager
    async def episode(self, data_id: str, *, track: str, benchmark: str, split: str | None = None,
                      candidate: str | None = None, is_train: bool = True,
                      metadata: dict | None = None) -> AsyncIterator[Episode]:
        rollout_id = f"{track}.{benchmark}.{data_id}.{uuid.uuid4().hex[:8]}"
        payload = {"data_id": data_id, "track": track, "benchmark": benchmark, "split": split, "candidate": candidate}
        await self._request("POST", "/api/rollouts", json=[{
            "rollout_id": rollout_id, "input": payload, "is_train": is_train,
            "metadata": metadata or {}}])
        await self._request("PATCH", f"/api/rollouts/{rollout_id}",
                            json={"status": {"state": "running", "last_attempt_id": DEFAULT_ATTEMPT_ID}})
        episode = Episode(rollout_id=rollout_id, input=payload)
        error: BaseException | None = None
        try:
            yield episode
        except BaseException as exc:  # recorded as a failed rollout, then re-raised
            error = exc
            raise
        finally:
            for event_type, data in episode.events:
                await self._post_event(rollout_id, episode.attempt_id, event_type, data)
            state = "failed" if error else "succeeded"
            patch = {"state": state}
            if error:
                patch["error_message"] = f"{type(error).__name__}: {error}"[:500]
            rollout = Rollout.model_validate(
                await self._request("PATCH", f"/api/rollouts/{rollout_id}", json={"status": patch}))
            writer = _BufferedWriter()
            if error:
                self.hooks.on_failed(rollout, writer)
            else:
                stored = [Event.model_validate(e) for e in await self.events(rollout_id)]
                self.hooks.on_succeeded(rollout, {episode.attempt_id: stored}, writer)
            for rid, aid, event_type, data in writer.events:
                await self._post_event(rid, aid, event_type, _jsonable(data))
                if event_type == "reward" and episode.reward_value is None:
                    episode.reward_value = float(data.get("value", 0.0))
            self.rollouts.append({"rollout_id": rollout_id, "state": state, "input": payload,
                                  "reward": episode.reward_value, "usage": episode.usage})


def _message_summary(message: Any) -> dict:
    contents = []
    for content in getattr(message, "contents", None) or []:
        kind = getattr(content, "type", "unknown")
        item: dict[str, Any] = {"type": kind}
        for attr in ("text", "name", "arguments", "call_id"):
            value = getattr(content, attr, None)
            if value not in (None, ""):
                item[attr] = value
        result = getattr(content, "result", None)
        if result is not None:
            item["result"] = str(result)
        contents.append(item)
    return {"role": str(getattr(message, "role", "")), "contents": contents}


class TracingChatMiddleware(ChatMiddleware):
    """Emits AGL ``model_request`` events (request, response, usage, latency) for every model call."""

    def __init__(self, episode_ref: "EpisodeRef", model: str) -> None:
        self.episode_ref = episode_ref
        self.model = model

    async def process(self, context: ChatContext, call_next) -> None:  # noqa: ANN001
        started = time.perf_counter()
        status, error = "ok", None
        try:
            await call_next()
        except Exception as exc:
            status, error = "error", f"{type(exc).__name__}: {exc}"
            raise
        finally:
            episode = self.episode_ref.current
            if episode is not None:
                result = context.result
                usage = getattr(result, "usage_details", None) or {}
                messages = list(getattr(result, "messages", None) or [])
                episode.record("model_request", {
                    "model": self.model,
                    "request": {"messages": [_message_summary(m) for m in context.messages][-6:],
                                "message_count": len(context.messages)},
                    "response": {"messages": [_message_summary(m) for m in messages], "error": error},
                    "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                    "status": status,
                    "usage": {k: int(usage.get(k) or 0) for k in USAGE_KEYS},
                    "finish_reason": str(getattr(result, "finish_reason", None) or ""),
                })


class EpisodeRef:
    """Mutable pointer so long-lived middleware can record into whichever episode is active."""

    def __init__(self) -> None:
        self.current: Episode | None = None

    def record(self, event: dict) -> None:
        if self.current is not None:
            data = dict(event)
            self.current.record(str(data.pop("type", "event")), data)
