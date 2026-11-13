"""One place that turns (benchmark, client kind, policy) into graded results, shared by the CLI and the tracks."""
from __future__ import annotations

import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .agent import chat_instructions, instructions
from .benchmarks import ItemResult, behavior, cruxeval, grounding, ifeval, summarize
from .benchmarks.chat import load_rows, write_jsonl
from .clients import azure_openai_client
from .config import Paths, paths
from .policy import Policy
from .tracing import Tracer

BENCHMARKS = ("behavior", "ifeval", "cruxeval", "grounding")
CLIENT_KINDS = ("scripted", "azure")
# Benchmarks whose graded outcome cannot vary between identical runs of a scripted client.
SCRIPTED = ("behavior", "grounding")


def make_factory(benchmark: str, client_kind: str, policy: Policy) -> Callable[..., Any]:
    """A client factory with the signature each benchmark expects.

    Scripted clients replay a fixed tool policy. They check harness mechanics and graders, never model quality.
    """
    if benchmark not in BENCHMARKS:
        raise ValueError(f"unknown benchmark {benchmark!r}; choose from {', '.join(BENCHMARKS)}")
    if client_kind == "scripted":
        if benchmark == "behavior":
            return behavior.handoff_script if policy.handoff_tool else behavior.paging_script
        if benchmark == "grounding":
            return grounding.lint_echo_script
        raise ValueError(f"{benchmark} needs a model; a scripted client would only grade a canned answer")
    if client_kind == "azure":
        shared: dict[str, Any] = {}

        def factory(*_: Any) -> Any:  # one Entra-authenticated client per run
            if "client" not in shared:
                shared["client"] = azure_openai_client()
            return shared["client"]

        return factory
    raise ValueError(f"unknown client kind {client_kind!r}; choose from {', '.join(CLIENT_KINDS)}")


def items(name: str, splits: Sequence[str] | None = None, p: Paths | None = None,
          limit: int | None = None) -> list[dict]:
    """The exact items a run will grade, in file order; ``limit`` keeps the first N of each split.

    Only the chat benchmarks are large enough to need a limit; the fixture benchmarks always run in full.
    """
    if name == "behavior":
        return behavior.load_cases(p or paths(), splits)
    if name == "grounding":
        return grounding.load_cases(splits)
    if name not in ("ifeval", "cruxeval"):
        raise ValueError(f"unknown benchmark {name!r}; choose from {', '.join(BENCHMARKS)}")
    rows = load_rows(name, splits)
    if limit is None:
        return rows
    if limit < 1:
        raise ValueError("limit must be at least 1")
    seen: dict[str, int] = {}
    kept = []
    for row in rows:
        seen[row["split"]] = seen.get(row["split"], 0) + 1
        if seen[row["split"]] <= limit:
            kept.append(row)
    return kept


async def run_benchmark(name: str, *, factory: Callable[..., Any], policy: Policy, tracer: Tracer,
                        track: str = "baseline", candidate: str = "baseline", splits: Sequence[str] | None = None,
                        model_name: str = "unknown", p: Paths | None = None, procedure: str | None = None,
                        concurrency: int = 4, limit: int | None = None) -> list[ItemResult]:
    common = {"policy": policy, "tracer": tracer, "track": track, "candidate": candidate, "splits": splits,
              "model_name": model_name, "p": p}
    if name == "behavior":
        return await behavior.run(factory, procedure=procedure, **common)
    if procedure is not None:
        raise ValueError("a procedure only applies to the behavior benchmark")
    if name == "grounding":
        return await grounding.run(factory, **common)
    module = {"ifeval": ifeval, "cruxeval": cruxeval}.get(name)
    if module is None:
        raise ValueError(f"unknown benchmark {name!r}; choose from {', '.join(BENCHMARKS)}")
    if limit is None:
        return await module.run(factory, concurrency=concurrency, **common)
    with tempfile.TemporaryDirectory(prefix="cicd-subset-") as subset:
        write_jsonl(Path(subset) / f"{name}.jsonl", items(name, splits, p, limit))
        return await module.run(factory, concurrency=concurrency, data_dir=Path(subset), **common)


def summary(results: list[ItemResult]) -> dict:
    return {**summarize(results), "items": {r.item: r.passed for r in results}}


def instruction_bytes(benchmark: str, policy: Policy, p: Paths | None = None, procedure: str | None = None) -> int:
    """UTF-8 bytes of the instructions this benchmark sends, with LF line endings.

    Deterministic prompt size for the keep-bar's efficiency criterion; it is not a latency claim. Skill
    catalog text and per-case inputs are excluded because no candidate changes them.
    """
    p = p or paths()
    if benchmark == "behavior":
        text = instructions(policy, p, root=None, fixture=True)
        text += "\n\n" + (procedure if procedure is not None else p.feedback_procedure.read_text(encoding="utf-8"))
    elif benchmark == "grounding":
        text = instructions(policy, p, root=Path("/workspace"), fixture=False)
    else:
        text = chat_instructions(policy, p)
    return len(text.replace("\r\n", "\n").encode("utf-8"))
