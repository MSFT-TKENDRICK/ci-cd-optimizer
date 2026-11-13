"""Lint-grounding benchmark: does the agent report exactly the rule IDs the linter returned?

Each case is a small fixture repository written to a fresh temporary root. Ground truth is the set of rule IDs
the bundled ``cicd-lint`` CLI reports for that root at run time, so the benchmark follows rule changes instead of
pinning stale answers. The agent runs in root mode with the real MCP tools and must end its answer with a
``Rule IDs:`` section. Reward is the F1 of that set against the truth; a case passes only on an exact match, so
a hallucinated or omitted rule ID always fails it.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..agent import build_agent
from ..clients import ScriptedChatClient
from ..config import Paths, paths
from ..policy import Policy
from ..tracing import Tracer
from . import ItemResult
from .chat import DATA_DIR, _infrastructure, sha256_file

BENCHMARK = "lint-grounding"
SECTION = "Rule IDs:"
PROMPT = ("Lint this repository with the `lint` tool and explain which CI/CD problems it found. End your answer with a "
          f"section headed exactly `{SECTION}` that lists every distinct rule ID the tool reported, one per line, and "
          "nothing after it. List only rule IDs the tool returned.")
_RULE_ID = re.compile(r"\b[a-z][a-z0-9-]*/[a-z0-9][a-z0-9-]*\b")
ClientFactory = Callable[[dict, Path], Any]
"""Builds a chat client for one case: (case, resolved root) -> client."""


def load_cases(splits: Sequence[str] | None = None, data_dir: Path | None = None) -> list[dict]:
    cases = json.loads(((data_dir or DATA_DIR) / "grounding.json").read_text(encoding="utf-8"))
    return [c for c in cases if not splits or c["split"] in splits]


def materialize(case: dict, root: Path) -> None:
    for rel, text in case["files"].items():
        target = (root / rel).resolve()
        if root.resolve() not in target.parents:
            raise ValueError(f"fixture path escapes its root: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))


def _lint_cli(p: Paths, *args: str) -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22+ is required for the lint-grounding benchmark")
    done = subprocess.run([node, str(p.mcp_bundle), "lint", *args], cwd=p.repo, capture_output=True, text=True,
                          encoding="utf-8", timeout=120)
    if done.returncode not in (0, 1):
        raise RuntimeError(f"cicd-lint failed ({done.returncode}): {done.stderr[:500]}")
    return done.stdout


def ground_truth(p: Paths, root: Path) -> set[str]:
    report = json.loads(_lint_cli(p, "--root", str(root), "--format", "json", "--fail-on", "never"))
    return {d["ruleId"] for d in report["diagnostics"]}


@lru_cache(maxsize=4)
def _catalog(bundle: str, repo: str) -> frozenset[str]:
    listing = _lint_cli(Paths(Path(repo)), "--list-rules")
    return frozenset(line.split()[0] for line in listing.splitlines() if line.split() and "/" in line.split()[0])


def catalog(p: Paths) -> frozenset[str]:
    return _catalog(str(p.mcp_bundle), str(p.repo))


def reported_ids(text: str, known: frozenset[str]) -> set[str]:
    """IDs in the final ``Rule IDs:`` section; without one, only catalog IDs mentioned anywhere count."""
    index = text.lower().rfind(SECTION.lower())
    if index >= 0:
        return set(_RULE_ID.findall(text[index + len(SECTION):]))
    return {token for token in _RULE_ID.findall(text) if token in known}


def grade(truth: set[str], text: str, known: frozenset[str]) -> tuple[bool, float, dict]:
    predicted = reported_ids(text, known)
    hit = predicted & truth
    precision = len(hit) / len(predicted) if predicted else (1.0 if not truth else 0.0)
    recall = len(hit) / len(truth) if truth else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return predicted == truth, round(f1, 4), {
        "truth": sorted(truth), "reported": sorted(predicted), "missed": sorted(truth - predicted),
        "hallucinated": sorted(predicted - truth), "unknownIds": sorted(predicted - known),
        "precision": round(precision, 4), "recall": round(recall, 4), "hasSection": SECTION.lower() in text.lower(),
    }


async def run(client_factory: ClientFactory, *, policy: Policy, tracer: Tracer, track: str = "baseline",
              candidate: str = "baseline", splits: Sequence[str] | None = None, model_name: str = "unknown",
              p: Paths | None = None, data_dir: Path | None = None) -> list[ItemResult]:
    p = p or paths()
    known = catalog(p)
    bundle_hash = sha256_file(p.mcp_bundle)
    results: list[ItemResult] = []
    for case in load_cases(splits, data_dir):
        work = Path(tempfile.mkdtemp(prefix="cicd-ground-"))
        try:
            materialize(case, work)
            root = Path(os.path.realpath(work))
            truth = ground_truth(p, root)
            client = client_factory(case, root)
            async with tracer.episode(case["id"], track=track, benchmark=BENCHMARK, split=case["split"],
                                      candidate=candidate, is_train=case["split"] == "train") as episode:
                text, error = "", None
                try:
                    async with build_agent(client, root=root, policy=policy, model_name=model_name, p=p) as session:
                        text = (await session.run(PROMPT, episode)).text or ""
                except Exception as exc:  # classified below; harness bugs still propagate
                    if not _infrastructure(exc):
                        raise
                    error = f"infrastructure: {type(exc).__name__}: {exc}"[:500]
                passed, reward, detail = grade(truth, text, known)
                if error:
                    passed, reward = False, 0.0
                tools = [c.get("tool") for c in episode.tool_calls]
                episode.reward(reward, reason=error, passed=passed, detail=detail)
                detail = {**detail, "lintCalled": "lint" in tools, "toolCalls": tools, "bundleSha256": bundle_hash,
                          "finalText": text[:1500]}
                results.append(ItemResult(BENCHMARK, case["id"], case["split"], passed, reward, detail,
                                          episode.usage, error))
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return results


# ---- Deterministic scripted policy: mechanics check for CI, never evidence of model quality. ----

def _tool_text(messages: Sequence[Any], name: str) -> list[str]:
    calls = {c.call_id: c.name for m in messages for c in (m.contents or []) if c.type == "function_call"}
    out = []
    for message in messages:
        for content in message.contents or []:
            if content.type == "function_result" and calls.get(content.call_id) == name:
                result = content.result
                if isinstance(result, list):
                    result = "".join(getattr(item, "text", None) or "" for item in result)
                out.append(str(result))
    return out


def lint_echo_script(case: dict, root: Path) -> ScriptedChatClient:
    """Calls lint on the root, then echoes exactly the rule IDs in the tool result."""

    def step(messages):
        results = _tool_text(messages, "lint")
        if not results:
            return ("call", "lint", {"root": str(root)})
        ids = sorted(set(re.findall(r'"ruleId"\s*:\s*"([^"]+)"', results[-1])))
        return ("text", "The linter reported these findings.\n\n" + SECTION + "\n" + "\n".join(ids))

    return ScriptedChatClient(step)
