"""Chat clients: a deterministic scripted client for CI and an Entra-authenticated Azure OpenAI client.

Scripted runs exercise orchestration mechanics only. They are never evidence of model quality.
"""
from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable, Sequence
from typing import Any

from agent_framework import (
    BaseChatClient,
    ChatMiddlewareLayer,
    ChatResponse,
    Content,
    FunctionInvocationLayer,
    Message,
    UsageDetails,
)
from agent_framework.observability import ChatTelemetryLayer


class InfrastructureError(RuntimeError):
    """The model route returned something other than a chat completion; not a model-quality failure."""


def is_infrastructure_error(exc: BaseException) -> bool:
    """A transport, quota or service failure, not a model answer; walks the cause chain MAF wraps."""
    try:
        import openai
        api_error: tuple[type, ...] = (openai.APIError,)
    except ImportError:  # pragma: no cover - openai is a hard dependency of the live client only
        api_error = ()
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (InfrastructureError, *api_error)):
            return True
        current = current.__cause__ or current.__context__
    return False


Step = tuple  # ("call", name, arguments) | ("text", content)
Policy = Callable[[Sequence[Message]], Step]


class ScriptedChatClient(FunctionInvocationLayer, ChatMiddlewareLayer, ChatTelemetryLayer, BaseChatClient):
    """Replays a fixed script, or asks a deterministic policy for the next step given the transcript."""

    def __init__(self, script: Sequence[Step] | Policy, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._policy = script if callable(script) else None
        self._script = [] if callable(script) else list(script)
        self.requests = 0
        self._calls = 0

    async def _respond(self, messages: Sequence[Message]) -> ChatResponse:
        self.requests += 1
        if self._policy is not None:
            step = self._policy(list(messages))
        elif self._script:
            step = self._script.pop(0)
        else:
            step = ("text", "")
        if step[0] == "call":
            self._calls += 1
            content = Content.from_function_call(call_id=f"call-{self._calls}", name=step[1], arguments=dict(step[2]))
        else:
            content = Content.from_text(step[1])
        usage = UsageDetails(input_token_count=0, output_token_count=0, total_token_count=0)
        return ChatResponse(messages=[Message("assistant", [content])], usage_details=usage)

    def _inner_get_response(self, *, messages, stream, options, **kwargs):  # noqa: ANN001 - framework signature
        if stream:
            raise NotImplementedError("ScriptedChatClient does not stream")
        return self._respond(messages)


def _require_json(response) -> None:  # noqa: ANN001 - httpx.Response
    """Reject intercepted or proxied replies (for example a plain-text 'OK') before the SDK parses them."""
    if response.request.url.path.endswith("/chat/completions") and response.is_success:
        kind = response.headers.get("content-type", "")
        if "json" not in kind:
            raise InfrastructureError(f"model route returned {kind or 'no content-type'} instead of a chat completion")


async def _validate(response) -> None:  # noqa: ANN001 - httpx.Response
    _require_json(response)
    if response.request.url.path.endswith("/chat/completions") and response.is_success:
        await response.aread()
        try:
            body = json.loads(response.content)
        except ValueError as error:
            raise InfrastructureError("model route returned invalid JSON") from error
        if not isinstance(body, dict) or body.get("object") != "chat.completion":
            raise InfrastructureError("model route returned a non chat.completion object")


def azure_openai_client(endpoint: str | None = None, deployment: str | None = None, **kwargs: Any):
    """Azure OpenAI through Entra ID (no API keys). Reads AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_DEPLOYMENT."""
    import httpx
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    from openai import AsyncOpenAI
    from agent_framework_openai import OpenAIChatCompletionClient

    endpoint = (endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT") or "").rstrip("/")
    deployment = deployment or os.environ.get("AZURE_OPENAI_DEPLOYMENT")
    if not endpoint or not deployment:
        raise ValueError("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT (or pass endpoint/deployment).")
    if not endpoint.endswith("/openai/v1"):
        endpoint += "/openai/v1"
    # Developer credentials shell out to az/azd; the 10 s default is too short on slower (e.g. ARM) machines.
    credential = DefaultAzureCredential(process_timeout=30)
    token = get_bearer_token_provider(credential, "https://cognitiveservices.azure.com/.default")

    async def api_key() -> str:
        return await asyncio.to_thread(token)

    http = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0), event_hooks={"response": [_validate]})
    sdk = AsyncOpenAI(base_url=endpoint + "/", api_key=api_key, http_client=http, max_retries=3)
    return OpenAIChatCompletionClient(model=deployment, async_client=sdk, **kwargs)


def usage_of(response) -> dict:  # noqa: ANN001 - AgentResponse
    usage = getattr(response, "usage_details", None) or {}
    return {key: int(usage.get(key) or 0) for key in ("input_token_count", "output_token_count", "reasoning_output_token_count")}
