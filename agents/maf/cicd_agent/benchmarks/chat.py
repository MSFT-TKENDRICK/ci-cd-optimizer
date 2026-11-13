"""Shared runner for single-turn chat benchmarks (IFEval, CRUXEval-O) on the tool-free agent persona."""
from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any

from ..agent import build_chat_agent
from ..clients import is_infrastructure_error
from ..config import Paths, paths
from ..policy import Policy
from ..tracing import Tracer
from . import ItemResult

DATA_DIR = Path(__file__).resolve().parent / "data"
SPLITS = ("train", "val", "test")
MAX_DETAIL_TEXT = 1500
ClientFactory = Callable[[dict], Any]
"""Builds (or returns a shared) chat client for one benchmark row."""
Grader = Callable[[dict, str], tuple[bool, float, dict]]
"""(row, response text) -> (passed, reward in [0, 1], detail)."""


def stable_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_jsonl(path: Path, rows: Iterable[dict]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Fixed separators and LF endings keep the subset hash identical on every platform.
    text = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows)
    path.write_bytes(text.encode("utf-8"))
    return sha256_file(path)


def load_rows(name: str, splits: Sequence[str] | None = None, data_dir: Path | None = None) -> list[dict]:
    path = (data_dir or DATA_DIR) / f"{name}.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [row for row in rows if not splits or row["split"] in splits]


_infrastructure = is_infrastructure_error


async def run_items(benchmark: str, rows: Sequence[dict], prompt_of: Callable[[dict], str], grade: Grader,
                    client_factory: ClientFactory, *, policy: Policy, tracer: Tracer, track: str = "baseline",
                    candidate: str = "baseline", model_name: str = "unknown", p: Paths | None = None,
                    concurrency: int = 4) -> list[ItemResult]:
    p = p or paths()
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def one(row: dict) -> ItemResult:
        async with semaphore:
            session = build_chat_agent(client_factory(row), policy=policy, model_name=model_name, p=p)
            async with tracer.episode(row["id"], track=track, benchmark=benchmark, split=row["split"],
                                      candidate=candidate, is_train=row["split"] == "train") as episode:
                text, error = "", None
                try:
                    text = (await session.run(prompt_of(row), episode)).text or ""
                except Exception as exc:  # classified below; harness bugs still propagate
                    if not _infrastructure(exc):
                        raise
                    error = f"infrastructure: {type(exc).__name__}: {exc}"[:500]
                passed, reward, detail = grade(row, text)
                if error:
                    passed, reward = False, 0.0
                episode.reward(reward, reason=error, passed=passed, detail=detail)
                detail = {**detail, "response": text[:MAX_DETAIL_TEXT]}
                return ItemResult(benchmark, row["id"], row["split"], passed, reward, detail, episode.usage, error)

    return list(await asyncio.gather(*(one(row) for row in rows)))
