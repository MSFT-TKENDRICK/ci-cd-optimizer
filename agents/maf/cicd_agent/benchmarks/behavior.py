"""CI-feedback behavior benchmark on the MAF agent.

The same seven fixture cases, prompt renderer, fixture MCP server and trace grader as the Copilot-hosted
harness in ``evals/feedback/behavior.py``, so MAF and Copilot scores are directly comparable. Each case runs
as one Agent Lightning episode whose reward is the share of grader checks that passed.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from ..agent import build_agent
from ..clients import ScriptedChatClient, is_infrastructure_error
from ..config import Paths, paths
from ..policy import Policy
from ..tracing import Tracer
from . import ItemResult

BENCHMARK = "ci-feedback-behavior"
OFFLINE_NOTE = ("\nOffline fixture: use only the provided read-only report tool, then record_disposition for your "
                "handoff. No repository changes or external calls. Finish after recording.")
MAX_PROCEDURE_BYTES = 8192
ClientFactory = Callable[[dict, dict], Any]
"""Builds a chat client for one case: (case, fixture data) -> client."""


def _grading(p: Paths):
    """Load the grader shared with the Copilot harness without putting evals/ on sys.path."""
    spec = importlib.util.spec_from_file_location("behavior_grading", p.repo / "evals" / "feedback" / "behavior_grading.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_cases(p: Paths | None = None, splits: Sequence[str] | None = None) -> list[dict]:
    p = p or paths()
    cases = json.loads(p.behavior_cases.read_text(encoding="utf-8"))
    return [c for c in cases if not splits or c["split"] in splits]


def render_prompt(p: Paths, fixture_path: Path, procedure_path: Path) -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22+ is required to render the feedback prompt")
    prompt = subprocess.check_output([
        node, "--input-type=module", "-e",
        "import {readFileSync} from 'node:fs'; import {renderFeedbackPrompt} from './scripts/feedback-harness.mjs';"
        "const [f,s]=process.argv.slice(1);process.stdout.write(renderFeedbackPrompt(JSON.parse(readFileSync(f,'utf8')).event,readFileSync(s,'utf8')));",
        str(fixture_path), str(procedure_path),
    ], cwd=p.repo, text=True, encoding="utf-8", timeout=60)
    return prompt + OFFLINE_NOTE


def read_trace(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


async def run(client_factory: ClientFactory, *, policy: Policy, tracer: Tracer, track: str = "baseline",
              candidate: str = "baseline", procedure: str | None = None, splits: Sequence[str] | None = None,
              model_name: str = "unknown", p: Paths | None = None, work: Path | None = None) -> list[ItemResult]:
    p = p or paths()
    procedure = procedure if procedure is not None else p.feedback_procedure.read_text(encoding="utf-8")
    if len(procedure.encode("utf-8")) > MAX_PROCEDURE_BYTES:
        raise ValueError(f"procedure exceeds {MAX_PROCEDURE_BYTES} bytes")
    grading = _grading(p)
    results: list[ItemResult] = []
    owned = work is None
    work = Path(tempfile.mkdtemp(prefix="cicd-behavior-")) if owned else work
    try:
        for case in load_cases(p, splits):
            target = work / f"{candidate}-{case['id']}"
            target.mkdir(parents=True, exist_ok=True)
            data = grading.fixture(case)
            fixture_path, trace_path, procedure_path = target / "fixture.json", target / "trace.jsonl", target / "procedure.md"
            fixture_path.write_text(json.dumps(data), encoding="utf-8")
            procedure_path.write_text(procedure, encoding="utf-8")
            trace_path.unlink(missing_ok=True)
            prompt = render_prompt(p, fixture_path, procedure_path)
            client = client_factory(case, data)
            async with tracer.episode(case["id"], track=track, benchmark=BENCHMARK, split=case["split"],
                                      candidate=candidate, is_train=case["split"] == "train") as episode:
                error = None
                text = ""
                try:
                    async with build_agent(client, fixture=(fixture_path, trace_path), policy=policy,
                                           model_name=model_name, p=p) as session:
                        response = await session.run(prompt, episode)
                        text = response.text or ""
                except Exception as exc:  # classified below; harness bugs still propagate
                    if not is_infrastructure_error(exc):
                        raise
                    error = f"infrastructure: {type(exc).__name__}: {exc}"[:500]
                trace = read_trace(trace_path)
                grade = grading.grade_trace(case, trace)
                checks = grade["checks"]
                reward = sum(checks.values()) / len(checks)
                episode.reward(0.0 if error else reward, reason=error, passed=grade["passed"] and not error,
                               checks=checks)
                results.append(ItemResult(BENCHMARK, case["id"], case["split"], bool(grade["passed"]) and not error,
                                          0.0 if error else reward,
                                          {"checks": checks, "reportCalls": sum(r["tool"] == "workflow_run_report" for r in trace),
                                           "toolCalls": [c["tool"] for c in episode.tool_calls], "finalText": text[:400]},
                                          episode.usage, error))
    finally:
        if owned:
            shutil.rmtree(work, ignore_errors=True)
    return results


# ---- Deterministic scripted policies: mechanics checks for CI, never evidence of model quality. ----

def _results(messages: Sequence[Any], name: str) -> list[str]:
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


def handoff_script(case: dict, data: dict) -> ScriptedChatClient:
    """Calls the skill-to-code tool, then records exactly the disposition it drafted."""
    report = data["report"]

    def step(messages):
        collected = _results(messages, "collect_run_report")
        if not collected:
            return ("call", "collect_run_report", {"repo": report["repo"], "run_id": case["run"], "run_attempt": case["attempt"]})
        if not _results(messages, "record_disposition"):
            return ("call", "record_disposition", json.loads(collected[-1])["disposition"])
        return ("text", "Recorded the disposition.")

    return ScriptedChatClient(step)


def paging_script(case: dict, data: dict) -> ScriptedChatClient:
    """Pages every report cursor by hand, as the procedure prescribes, then records the expected disposition."""
    report, size = data["report"], data["pageSize"]
    base = {"repo": report["repo"], "runId": case["run"], "runAttempt": case["attempt"]}
    calls: list[dict] = [dict(base)]
    if case["kind"] != "blocked":
        for key, items in (("jobOffset", report["jobs"]), ("stepOffset", report["slowestSteps"]),
                           ("findingOffset", report["attribution"]["bottlenecks"]), ("gapOffset", report["attribution"]["gaps"])):
            calls += [{**base, key: index} for index in range(size, len(items), size)]
        for index in range(0, len(report["attribution"]["bottlenecks"]), size):
            calls.append({**base, "findingOffset": index, "evidenceOffset": 3})
    queue = calls if case["kind"] != "blocked" else calls[:1]
    execution, queue_ms = case["execution"], case["queue"]
    disposition = {"runId": case["run"], "runAttempt": case["attempt"], "status": case["kind"],
                   "executionMs": execution,
                   "queueInclusiveMs": None if execution is None else execution + queue_ms,
                   "runnerMs": case["runner"], "elapsedSavingsBoundMs": case["bound"],
                   "measuredElapsedSavingsMs": None,
                   "summary": f"Run {case['run']} attempt {case['attempt']} is {case['kind']}; savings are bounds, not measured."}
    steps = [("call", "workflow_run_report", args) for args in queue]
    steps += [("call", "record_disposition", disposition), ("text", "Recorded the disposition.")]
    return ScriptedChatClient(steps)


def summary_of(results: list[ItemResult]) -> dict:
    from . import summarize

    return {**summarize(results), "items": {r.item: r.passed for r in results}}
