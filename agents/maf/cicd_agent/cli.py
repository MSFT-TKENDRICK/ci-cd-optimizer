"""Command line: chat with the agent, serve it over HTTP, grade it on a benchmark or run a hill-climbing track."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from .policy import REASONING_EFFORTS, Policy

TRACKS = ("skill", "agent", "harness")


def _policy(args: argparse.Namespace) -> Policy:
    overrides: dict[str, Any] = {}
    if getattr(args, "variant", None):
        overrides["instructions_variant"] = args.variant
    if getattr(args, "handoff_tool", False):
        overrides["handoff_tool"] = True
    if getattr(args, "reasoning_effort", None):
        overrides["reasoning_effort"] = args.reasoning_effort
    return Policy.load(Path(args.policy) if args.policy else None, **overrides)


def _model_name(args: argparse.Namespace) -> str:
    return args.model_name or os.environ.get("AZURE_OPENAI_DEPLOYMENT") or "unknown"


def _write_json(path: str | None, data: Any) -> None:
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


async def _chat(args: argparse.Namespace) -> int:
    from .agent import build_agent, build_chat_agent
    from .clients import azure_openai_client
    from .tracing import Tracer

    policy, model = _policy(args), _model_name(args)
    client = azure_openai_client()
    async with Tracer(jsonl=Path(args.jsonl) if args.jsonl else None, model_name=model) as tracer:
        async with tracer.episode("cli-chat", track="cli", benchmark="chat", is_train=False) as episode:
            if args.root:
                async with build_agent(client, root=Path(args.root), policy=policy, model_name=model) as session:
                    response = await session.run(args.message, episode)
            else:
                response = await build_chat_agent(client, policy=policy, model_name=model).run(args.message, episode)
    print(response.text or "")
    return 0


async def _bench(args: argparse.Namespace) -> int:
    from . import runner
    from .tracing import Tracer

    policy, model = _policy(args), _model_name(args)
    factory = runner.make_factory(args.name, args.client, policy)
    procedure = Path(args.procedure).read_text(encoding="utf-8") if args.procedure else None
    splits = args.splits.split(",") if args.splits else None
    async with Tracer(jsonl=Path(args.jsonl) if args.jsonl else None, model_name=model) as tracer:
        results = await runner.run_benchmark(
            args.name, factory=factory, policy=policy, tracer=tracer, track=args.track, candidate=args.candidate,
            splits=splits, model_name=model, procedure=procedure, concurrency=args.concurrency, limit=args.limit)
    summary = runner.summary(results)
    print(json.dumps(summary, indent=2))
    _write_json(args.out, [r.as_dict() for r in results])
    return 0 if summary["errors"] == 0 else 3


async def _climb(args: argparse.Namespace) -> int:
    from .tracks import run_track

    report = await run_track(args.track, client_kind=args.client, policy_path=Path(args.policy) if args.policy else None,
                             model_name=_model_name(args), limit=args.limit, concurrency=args.concurrency,
                             stage=Path(args.stage) if args.stage else None, jsonl=Path(args.jsonl) if args.jsonl else None,
                             max_rounds=args.max_rounds, max_invocations=args.max_invocations,
                             max_minutes=args.max_minutes,
                             benchmarks=[b.strip() for b in args.benchmarks.split(",") if b.strip()]
                             if args.benchmarks else None)
    print(json.dumps({k: report[k] for k in ("track", "status", "selected", "reason") if k in report}, indent=2))
    _write_json(args.out, report)
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="cicd-agent", description=__doc__)
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--policy", help="policy JSON (default: agents/maf/policy.json or CICD_AGENT_POLICY)")
    shared.add_argument("--model-name", help="label for traces (default: AZURE_OPENAI_DEPLOYMENT)")
    shared.add_argument("--jsonl", help="also write Agent Lightning spans and rewards to this JSONL file")
    variant = argparse.ArgumentParser(add_help=False)
    variant.add_argument("--variant", help="instructions variant from agents/maf/instructions/")
    variant.add_argument("--handoff-tool", action="store_true", help="expose the skill-to-code collect_run_report tool")
    variant.add_argument("--reasoning-effort", choices=REASONING_EFFORTS,
                         help="reasoning level for every model request (default: the deployment's)")
    sub = root.add_subparsers(dest="command", required=True)

    chat = sub.add_parser("chat", parents=[shared, variant], help="ask the agent one question on Azure OpenAI")
    chat.add_argument("message")
    chat.add_argument("--root", help="lint this workspace with the read-only MCP tools")

    serve = sub.add_parser("serve", help="serve the agent over HTTP (needs CICD_AGENT_API_KEY)")
    serve.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))  # noqa: S104 - container entrypoint
    serve.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))

    from .runner import BENCHMARKS, CLIENT_KINDS

    bench = sub.add_parser("bench", parents=[shared, variant], help="grade the agent on one benchmark")
    bench.add_argument("name", choices=BENCHMARKS)
    bench.add_argument("--client", choices=CLIENT_KINDS, default="scripted")
    bench.add_argument("--splits", help="comma-separated: train,val,test (default: all)")
    bench.add_argument("--track", default="baseline")
    bench.add_argument("--candidate", default="baseline")
    bench.add_argument("--procedure", help="behavior only: procedure file to evaluate instead of the plugin's")
    bench.add_argument("--limit", type=int, help="ifeval/cruxeval only: first N items of each split")
    bench.add_argument("--concurrency", type=int, default=4)
    bench.add_argument("--out", help="write per-item results to this JSON file")

    climb = sub.add_parser("climb", parents=[shared], help="run one hill-climbing track and stage its proposal")
    climb.add_argument("track", choices=TRACKS)
    climb.add_argument("--client", choices=CLIENT_KINDS, default="scripted")
    climb.add_argument("--benchmarks", help="comma-separated benchmarks to score (default: the track's defaults)")
    climb.add_argument("--limit", type=int, default=20, help="ifeval/cruxeval items per split")
    climb.add_argument("--concurrency", type=int, default=4)
    climb.add_argument("--stage", help="directory for staged proposals (default: .agent-artifacts/maf-climb)")
    climb.add_argument("--max-rounds", type=int, default=4)
    climb.add_argument("--max-invocations", type=int, default=120)
    climb.add_argument("--max-minutes", type=float, default=45.0)
    climb.add_argument("--out", help="write the track report to this JSON file")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "serve":
            from .server import serve

            serve(host=args.host, port=args.port)
            return 0
        handler = {"chat": _chat, "bench": _bench, "climb": _climb}[args.command]
        return asyncio.run(handler(args))
    except (ValueError, RuntimeError, FileNotFoundError) as error:
        print(f"cicd-agent: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
