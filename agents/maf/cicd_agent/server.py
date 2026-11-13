"""HTTP service for the MAF agent, as deployed by the Azure Container Apps template.

``POST /chat`` takes ``{"message": str, "files": [{"path": str, "text": str}]}``. Without files the request
uses the tool-less chat persona. With files, the server writes them into a fresh temporary workspace and
runs the read-only agent confined to that workspace. Nothing is read from or written to the host
otherwise, and the workspace is deleted after the response.

The service fails closed: it refuses to start without an API key of at least 32 characters, and every
``/chat`` request needs ``Authorization: Bearer <key>``.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import tempfile
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .agent import build_agent, build_chat_agent
from .clients import azure_openai_client, is_infrastructure_error, usage_of
from .config import Paths, paths
from .policy import Policy
from .tracing import Episode, Tracer

log = logging.getLogger("cicd_agent.server")

MAX_BODY_BYTES = 512 * 1024
MAX_MESSAGE_CHARS = 16_000
MAX_FILES = 20
MAX_FILES_BYTES = 256 * 1024
MAX_PATH_CHARS = 200
MAX_PATH_DEPTH = 12
_SEGMENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,99}|\.[A-Za-z0-9_][A-Za-z0-9._-]{0,98}")
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}


class RequestError(ValueError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def validate_path(raw: Any) -> str:
    """Accept only short, relative, POSIX-style paths made of plain segments."""
    if not isinstance(raw, str) or not raw or len(raw) > MAX_PATH_CHARS:
        raise RequestError(400, "each file needs a relative path of at most 200 characters")
    if "\\" in raw or "\x00" in raw or raw.startswith("/") or ":" in raw:
        raise RequestError(400, f"file path must be relative and use forward slashes: {raw!r}")
    parts = PurePosixPath(raw).parts
    if not parts or len(parts) > MAX_PATH_DEPTH:
        raise RequestError(400, f"file path is empty or too deep: {raw!r}")
    for part in parts:
        if part in (".", "..") or not _SEGMENT.fullmatch(part) or part.split(".")[0].lower() in _RESERVED:
            raise RequestError(400, f"file path segment is not allowed: {raw!r}")
    return "/".join(parts)


def parse_request(body: bytes) -> tuple[str, dict[str, str]]:
    if len(body) > MAX_BODY_BYTES:
        raise RequestError(413, f"request body exceeds {MAX_BODY_BYTES} bytes")
    try:
        data = json.loads(body)
    except ValueError as error:
        raise RequestError(400, "request body must be JSON") from error
    if not isinstance(data, dict):
        raise RequestError(400, "request body must be a JSON object")
    unknown = set(data) - {"message", "files"}
    if unknown:
        raise RequestError(400, f"unknown fields: {sorted(unknown)}")
    message = data.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE_CHARS:
        raise RequestError(400, f"message must be a non-empty string of at most {MAX_MESSAGE_CHARS} characters")
    files_in = data.get("files") or []
    if not isinstance(files_in, list) or len(files_in) > MAX_FILES:
        raise RequestError(400, f"files must be a list of at most {MAX_FILES} entries")
    files: dict[str, str] = {}
    total = 0
    for item in files_in:
        if not isinstance(item, dict) or set(item) - {"path", "text"} or not isinstance(item.get("text"), str):
            raise RequestError(400, "each file must be {\"path\": str, \"text\": str}")
        path = validate_path(item.get("path"))
        if path.lower() in {p.lower() for p in files}:
            raise RequestError(400, f"duplicate file path: {path}")
        total += len(item["text"].encode("utf-8"))
        if total > MAX_FILES_BYTES:
            raise RequestError(413, f"files exceed {MAX_FILES_BYTES} bytes in total")
        files[path] = item["text"]
    return message, files


def write_workspace(root: Path, files: dict[str, str]) -> None:
    base = Path(os.path.realpath(root))
    for rel, text in files.items():
        target = Path(os.path.realpath(base / rel))
        if base not in target.parents:
            raise RequestError(400, f"file path escapes the workspace: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def _error(status: int, message: str, **headers: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status, headers=headers or None)


def create_app(*, api_key: str | None = None, client_factory: Callable[[], Any] | None = None,
               policy: Policy | None = None, p: Paths | None = None, model_name: str | None = None,
               max_concurrency: int | None = None) -> Starlette:
    api_key = api_key if api_key is not None else os.environ.get("CICD_AGENT_API_KEY", "")
    if len(api_key) < 32:
        raise RuntimeError("CICD_AGENT_API_KEY must be set to at least 32 characters; the service fails closed")
    p = p or paths()
    policy = policy or Policy.load(p.policy)
    model_name = model_name or os.environ.get("AZURE_OPENAI_DEPLOYMENT", "unknown")
    if client_factory is None:
        shared: dict[str, Any] = {}

        def client_factory() -> Any:  # one Entra-authenticated client for the process
            if "client" not in shared:
                shared["client"] = azure_openai_client()
            return shared["client"]

    limit = max_concurrency or int(os.environ.get("CICD_AGENT_MAX_CONCURRENCY", "2"))
    gate = asyncio.Semaphore(max(1, limit))
    timeout = policy.max_duration_seconds + 30
    expected = api_key.encode("utf-8")
    state: dict[str, Any] = {"tracer": None}

    async def run_episode(message: str, files: dict[str, str], episode: Episode) -> dict:
        client = client_factory()
        if not files:
            response = await build_chat_agent(client, policy=policy, model_name=model_name, p=p).run(message, episode)
            return {"mode": "chat", "text": response.text, "usage": usage_of(response)}
        with tempfile.TemporaryDirectory(prefix="cicd-agent-") as tmp:
            write_workspace(Path(tmp), files)
            async with build_agent(client, root=Path(tmp), policy=policy, model_name=model_name, p=p) as session:
                response = await session.run(message, episode)
                return {"mode": "workspace", "text": response.text, "usage": usage_of(response),
                        "violations": list(session.policy_middleware.violations)}

    async def healthz(_: Request) -> JSONResponse:
        ready = p.mcp_bundle.is_file() and p.agent_definition.is_file()
        return JSONResponse({"status": "ok" if ready else "degraded", "model": model_name},
                            status_code=200 if ready else 503)

    async def chat(request: Request) -> JSONResponse:
        if not hmac.compare_digest(_bearer(request).encode("utf-8"), expected):
            return _error(401, "missing or invalid bearer token", **{"WWW-Authenticate": "Bearer"})
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return _error(413, f"request body exceeds {MAX_BODY_BYTES} bytes")
        body = b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                return _error(413, f"request body exceeds {MAX_BODY_BYTES} bytes")
        try:
            message, files = parse_request(body)
        except RequestError as error:
            return _error(error.status, str(error))
        if gate.locked():
            return _error(429, "the agent is busy; retry shortly", **{"Retry-After": "10"})
        async with gate:
            request_id = uuid.uuid4().hex
            started = time.perf_counter()
            tracer: Tracer | None = state["tracer"]
            try:
                if tracer is not None:
                    async with tracer.episode(request_id, track="serve", benchmark="chat", is_train=False,
                                              metadata={"files": len(files)}) as episode:
                        result = await asyncio.wait_for(run_episode(message, files, episode), timeout)
                    tracer.rollouts.clear()
                else:
                    episode = Episode(rollout_id=request_id, input={"files": len(files)})
                    result = await asyncio.wait_for(run_episode(message, files, episode), timeout)
            except asyncio.TimeoutError:
                return _error(504, "the agent did not finish within its time budget")
            except RequestError as error:
                return _error(error.status, str(error))
            except Exception as error:
                if not is_infrastructure_error(error):
                    raise
                # Upstream details can include endpoints or request IDs; log them, return a generic reason.
                log.warning("model route error for %s: %s: %s", request_id, type(error).__name__, error)
                return _error(502, "the model route failed; retry later")
            result.update({"id": request_id, "model": model_name,
                           "toolCalls": [call.get("tool") for call in episode.tool_calls],
                           "elapsedMs": round((time.perf_counter() - started) * 1000)})
            return JSONResponse(result)

    @asynccontextmanager
    async def lifespan(_: Starlette):
        # Stream rollouts to a shared Agent Lightning store only when one is configured.
        if os.environ.get("AGL_SERVER_URL"):
            async with Tracer(model_name=model_name) as tracer:
                state["tracer"] = tracer
                yield
            state["tracer"] = None
        else:
            yield

    return Starlette(routes=[Route("/healthz", healthz, methods=["GET"]), Route("/chat", chat, methods=["POST"])],
                     lifespan=lifespan)


def serve(host: str = "0.0.0.0", port: int = 8000) -> None:  # noqa: S104 - container entrypoint
    import uvicorn

    uvicorn.run(create_app(), host=host, port=port, proxy_headers=True, forwarded_allow_ips="*",
                server_header=False, log_level=os.environ.get("CICD_AGENT_LOG_LEVEL", "info"))
