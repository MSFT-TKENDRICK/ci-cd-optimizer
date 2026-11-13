"""Greedy hill-climb shared by the three tracks: the repository keep-bar, a run leash and staged proposals.

A track supplies proposals (fixed candidates or model-written ones). Each round evaluates the incumbent plus
one proposal on the train and val splits. A proposal that clears the keep-bar becomes the incumbent. The climb
stops after two successive non-qualifying proposals, when proposals run out, or when the leash is exhausted.
Only then does the held-out test split run, once for the baseline and once for the final incumbent.

Everything is staged under ``.agent-artifacts``; the climb never edits a maintained file.
"""
from __future__ import annotations

import dataclasses
import json
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .. import runner
from ..benchmarks import ItemResult
from ..config import Paths, paths
from ..policy import Policy
from ..stats import paired_sign
from ..tracing import Tracer

SCHEMA = "cicd-agent/climb-v1"
SELECTION_SPLITS = ("train", "val")
TEST_SPLITS = ("test",)
# Behavior-grader checks about style rather than correctness; every other check is a guard.
STYLE_CHECKS = frozenset({"concise"})
MIN_EFFICIENCY_GAIN = 0.15
SIGNIFICANCE = 0.10
MAX_NON_QUALIFYING = 2
# Share of items that may fail with infrastructure errors before an evaluation is unusable.
MAX_ERROR_SHARE = 0.10

DETERMINISTIC_NOTE = ("Scripted clients replay fixed tool policies. This run proves climb mechanics, graders, "
                      "guards and staging; it is not evidence of model quality.")
STOCHASTIC_NOTE = ("Live model. Two baseline runs set the A/A noise floor; pass rates carry Wilson 95% intervals "
                   "and comparisons use exact paired sign tests on identical items. Request and byte savings are "
                   "measured on these items only, not latency claims.")

Run = dict[str, list[ItemResult]]
Key = tuple[str, str]


@dataclass(frozen=True)
class Candidate:
    """One delta on top of the incumbent: policy field overrides and/or a replacement procedure."""

    name: str
    description: str
    policy_overrides: dict = field(default_factory=dict)
    procedure: str | None = None
    uses_train: bool = False  # written from train failures, so train only guards against regressions


@dataclass
class Evaluation:
    name: str
    policy: Policy
    procedure: str | None
    runs: list[Run]


@dataclass
class ClimbState:
    """What a proposer may read. ``incumbent.runs`` holds train results only, so val and test stay held out."""

    track: str
    client_kind: str
    model_name: str
    incumbent: Evaluation
    tracer: Tracer
    p: Paths
    round: int


Proposer = Callable[[ClimbState], Awaitable[Candidate | None]]


@dataclass(frozen=True)
class TrackSpec:
    name: str
    goal: str
    allowed: tuple[str, ...]
    defaults: dict[str, tuple[str, ...]]
    proposals: Callable[[str, Paths], list[Candidate | Proposer]]
    proposer_cost: int = 1  # model calls a proposer may spend, charged to the leash


def _index(run: Run) -> dict[Key, ItemResult]:
    return {(bench, r.item): r for bench, results in run.items() for r in results}


def _requests(run: Run, keys: Sequence[Key]) -> int:
    index = _index(run)
    return sum(int(index[k].usage.get("requests", 0)) for k in keys)


def _output_tokens(run: Run, keys: Sequence[Key]) -> int:
    index = _index(run)
    return sum(int(index[k].usage.get("output_token_count") or 0) for k in keys)


def _reduction(before: float, after: float) -> float:
    return round(1 - after / before, 4) if before > 0 else 0.0


def train_view(evaluation: Evaluation) -> Evaluation:
    runs = [{bench: [r for r in results if r.split == "train"] for bench, results in run.items()}
            for run in evaluation.runs]
    return Evaluation(evaluation.name, evaluation.policy, evaluation.procedure, runs)


def proposal_name(proposal: Candidate | Proposer) -> str:
    return getattr(proposal, "name", None) or getattr(proposal, "__name__", "proposer")


def guard_violations(incumbent: Sequence[dict[Key, ItemResult]], candidate: dict[Key, ItemResult],
                     keys: Sequence[Key]) -> list[str]:
    """Correctness guards an aggregate gain must never hide.

    Behavior: a non-style check the incumbent passed in every run may not fail. Grounding: no item may report a
    hallucinated rule ID the incumbent never reported, and hallucinated or unknown IDs may not increase in total.
    """
    out: list[str] = []
    for key in keys:
        bench, item = key
        result = candidate[key]
        if bench == "behavior":
            for check, ok in sorted(result.detail.get("checks", {}).items()):
                stable = all(ix[key].detail.get("checks", {}).get(check) for ix in incumbent)
                if check not in STYLE_CHECKS and stable and not ok:
                    out.append(f"{item}: check {check} newly failed")
        elif bench == "grounding":
            seen = set().union(*(set(ix[key].detail.get("hallucinated", [])) for ix in incumbent))
            new = sorted(set(result.detail.get("hallucinated", [])) - seen)
            if new:
                out.append(f"{item}: new hallucinated rule IDs {new}")
    grounding = [k for k in keys if k[0] == "grounding"]
    for name in ("hallucinated", "unknownIds"):
        before = max(sum(len(ix[k].detail.get(name, [])) for k in grounding) for ix in incumbent) if grounding else 0
        after = sum(len(candidate[k].detail.get(name, [])) for k in grounding)
        if after > before:
            out.append(f"grounding: {name} rose from {before} to {after}")
    return out


def judge(incumbent: Sequence[Run], candidate: Run, *, select: Sequence[str], guard: Sequence[str] = (),
          deterministic: bool, aa_net: int = 0, instruction_bytes: tuple[int, int] = (0, 0)) -> dict:
    """The keep-bar. Returns the verdict with every number it used.

    Hard requirements: usable runs, no per-case regression on an item the incumbent passed in every run, and no
    guard violation, on both ``select`` and ``guard`` splits. Then one criterion on the ``select`` splits:

    - pass gain: deterministic, any win; stochastic, sign-test p <= 0.10 and net wins above the A/A net;
    - efficiency at equal behavior (losses <= wins): at least 15% fewer model requests, or, for a live model,
      at least 15% fewer instruction bytes. A scripted client ignores instruction text, so bytes never qualify it.
    """
    inc = [_index(r) for r in incumbent]
    cand = _index(candidate)
    scope = set(select) | set(guard)
    keys = sorted(k for k, r in inc[0].items() if r.split in scope)
    missing = [k for k in keys if k not in cand]
    if missing:
        raise ValueError(f"candidate is missing items {missing[:5]}")
    cand_errors = [k for k in keys if cand[k].error]
    errored = {k for k in keys if cand[k].error or any(ix[k].error for ix in inc)}
    usable = [k for k in keys if k not in errored]
    selected = [k for k in usable if inc[0][k].split in select]
    sign = paired_sign([inc[0][k].passed for k in selected], [cand[k].passed for k in selected])
    stable = {k for k in usable if all(ix[k].passed for ix in inc)}
    regressions = [f"{b}/{i}" for b, i in usable if (b, i) in stable and not cand[(b, i)].passed]
    violations = guard_violations(inc, cand, usable)
    before_requests = sum(_requests(r, selected) for r in incumbent) / len(incumbent)
    after_requests = _requests(candidate, selected)
    before_output = sum(_output_tokens(r, selected) for r in incumbent) / len(incumbent)
    after_output = _output_tokens(candidate, selected)
    verdict: dict[str, Any] = {
        "items": len(keys), "compared": len(selected), "excludedForErrors": sorted(f"{b}/{i}" for b, i in errored),
        "sign": sign, "aaNet": aa_net, "regressions": regressions, "guardViolations": violations,
        "requests": {"incumbent": round(before_requests, 2), "candidate": after_requests,
                     "reduction": _reduction(before_requests, after_requests)},
        # Reported, not gated: a pass gain may cost output tokens (for example reasoning), which callers must weigh.
        "outputTokens": {"incumbent": round(before_output, 2), "candidate": after_output,
                         "reduction": _reduction(before_output, after_output)},
        "instructionBytes": {"incumbent": instruction_bytes[0], "candidate": instruction_bytes[1],
                             "reduction": _reduction(*instruction_bytes)},
        "qualifies": False, "criterion": None,
    }
    if len(cand_errors) > MAX_ERROR_SHARE * len(keys):
        verdict["reason"] = f"{len(cand_errors)} of {len(keys)} items hit infrastructure errors; rerun before judging"
        return verdict
    if regressions:
        verdict["reason"] = f"per-case regression on {', '.join(regressions[:5])}"
        return verdict
    if violations:
        verdict["reason"] = f"guard violation: {'; '.join(violations[:3])}"
        return verdict
    net = sign["wins"] - sign["losses"]
    if deterministic and sign["wins"] > 0:
        verdict.update(qualifies=True, criterion="pass-gain", reason=f"{sign['wins']} new passes, no regressions")
    elif not deterministic and sign["p"] <= SIGNIFICANCE and net > aa_net:
        verdict.update(qualifies=True, criterion="pass-gain",
                       reason=f"net {net} wins (p={sign['p']}) exceeds the A/A net of {aa_net}")
    elif sign["losses"] > sign["wins"]:
        verdict["reason"] = f"{sign['losses']} losses against {sign['wins']} wins"
    elif verdict["requests"]["reduction"] >= MIN_EFFICIENCY_GAIN:
        verdict.update(qualifies=True, criterion="model-requests",
                       reason=f"{verdict['requests']['reduction']:.0%} fewer model requests at equal behavior")
    elif not deterministic and verdict["instructionBytes"]["reduction"] >= MIN_EFFICIENCY_GAIN:
        verdict.update(qualifies=True, criterion="instruction-bytes",
                       reason=f"{verdict['instructionBytes']['reduction']:.0%} fewer instruction bytes at equal behavior")
    else:
        why = "no pass gain beyond the noise floor and under 15% fewer requests"
        if deterministic:
            why += "; instruction bytes cannot qualify a scripted client, which ignores instruction text"
        else:
            why += " or instruction bytes"
        verdict["reason"] = why
    return verdict


class Climb:
    def __init__(self, spec: TrackSpec, *, client_kind: str, base: Policy, model_name: str, limit: int | None,
                 concurrency: int, benchmarks: Sequence[str], tracer: Tracer, max_rounds: int,
                 max_invocations: int, max_minutes: float, p: Paths) -> None:
        self.spec, self.client_kind, self.base, self.model_name = spec, client_kind, base, model_name
        self.limit, self.concurrency, self.benchmarks, self.tracer, self.p = limit, concurrency, list(benchmarks), tracer, p
        self.max_rounds, self.max_invocations, self.max_minutes = max_rounds, max_invocations, max_minutes
        self.deterministic = client_kind == "scripted"
        self.used = 0
        self.started = time.monotonic()
        self._cost: dict[tuple[str, ...], int] = {}

    def cost(self, splits: Sequence[str]) -> int:
        key = tuple(splits)
        if key not in self._cost:
            self._cost[key] = sum(len(runner.items(b, splits, self.p, self.limit if b in ("ifeval", "cruxeval") else None))
                                  for b in self.benchmarks)
        return self._cost[key]

    @property
    def reserve(self) -> int:
        return 2 * self.cost(TEST_SPLITS)

    def fits(self, invocations: int) -> bool:
        return self.used + invocations + self.reserve <= self.max_invocations

    def minutes(self) -> float:
        return (time.monotonic() - self.started) / 60

    async def run_once(self, name: str, policy: Policy, procedure: str | None, splits: Sequence[str]) -> Run:
        run: Run = {}
        for bench in self.benchmarks:
            factory = runner.make_factory(bench, self.client_kind, policy)
            run[bench] = await runner.run_benchmark(
                bench, factory=factory, policy=policy, tracer=self.tracer, track=self.spec.name, candidate=name,
                splits=splits, model_name=self.model_name, p=self.p,
                procedure=procedure if bench == "behavior" else None, concurrency=self.concurrency,
                limit=self.limit if bench in ("ifeval", "cruxeval") else None)
            self.used += len(run[bench])
        return run

    def bytes_of(self, policy: Policy, procedure: str | None) -> int:
        return sum(runner.instruction_bytes(b, policy, self.p, procedure if b == "behavior" else None)
                   for b in self.benchmarks)


def summaries(run: Run) -> dict:
    return {bench: runner.summary(results) for bench, results in run.items()}


def total_usage(runs: Sequence[Run], extra: Sequence[dict] = ()) -> dict:
    usage: dict[str, int] = {}
    for item in [r.usage for run in runs for results in run.values() for r in results] + list(extra):
        for key, value in item.items():
            usage[key] = usage.get(key, 0) + int(value)
    return usage


def _stage(stage: Path, evaluations: Sequence[Evaluation], selected: Evaluation | None, report: dict) -> None:
    stage.mkdir(parents=True, exist_ok=True)
    for evaluation in evaluations:
        target = stage / "candidates" / evaluation.name
        target.mkdir(parents=True, exist_ok=True)
        (target / "policy.json").write_text(json.dumps(evaluation.policy.as_json(), indent=2) + "\n", encoding="utf-8")
        if evaluation.procedure is not None:
            (target / "procedure.md").write_text(evaluation.procedure, encoding="utf-8")
    if selected is not None:
        target = stage / "selected"
        target.mkdir(parents=True, exist_ok=True)
        (target / "policy.json").write_text(json.dumps(selected.policy.as_json(), indent=2) + "\n", encoding="utf-8")
        if selected.procedure is not None:
            (target / "procedure.md").write_text(selected.procedure, encoding="utf-8")
    (stage / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def default_stage(p: Paths, track: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return p.repo / ".agent-artifacts" / "maf-climb" / track / stamp


def resolve_benchmarks(spec: TrackSpec, client_kind: str, requested: Sequence[str] | None) -> list[str]:
    chosen = list(requested) if requested else list(spec.defaults[client_kind])
    unknown = [b for b in chosen if b not in spec.allowed]
    if unknown:
        raise ValueError(f"the {spec.name} track scores {', '.join(spec.allowed)}; not {', '.join(unknown)}")
    if client_kind == "scripted":
        live = [b for b in chosen if b not in runner.SCRIPTED]
        if live:
            raise ValueError(f"{', '.join(live)} needs a model; use --client azure or drop it from --benchmarks")
    if len(set(chosen)) != len(chosen) or not chosen:
        raise ValueError("--benchmarks must name each benchmark once")
    return chosen


async def climb(spec: TrackSpec, *, client_kind: str, policy_path: Path | None, model_name: str,
                limit: int | None, concurrency: int, stage: Path | None, jsonl: Path | None, max_rounds: int,
                max_invocations: int, max_minutes: float, benchmarks: Sequence[str] | None = None,
                p: Paths | None = None) -> dict:
    p = p or paths()
    if client_kind not in runner.CLIENT_KINDS:
        raise ValueError(f"unknown client kind {client_kind!r}; choose from {', '.join(runner.CLIENT_KINDS)}")
    if max_rounds < 1 or max_invocations < 1 or max_minutes <= 0:
        raise ValueError("the leash needs at least one round, one invocation and a positive time limit")
    if limit is not None and limit < 1:
        raise ValueError("limit must be at least 1")
    chosen = resolve_benchmarks(spec, client_kind, benchmarks)
    base = Policy.load(policy_path)
    stage = stage or default_stage(p, spec.name)
    report: dict[str, Any] = {
        "schema": SCHEMA, "track": spec.name, "goal": spec.goal, "clientKind": client_kind, "model": model_name,
        "mode": {"deterministic": client_kind == "scripted",
                 "note": DETERMINISTIC_NOTE if client_kind == "scripted" else STOCHASTIC_NOTE},
        "benchmarks": chosen, "limit": limit, "status": None, "selected": None, "reason": None,
        "adoption": "Staged only. Review the staged diff and adopt deliberately; the climb never edits maintained files.",
    }
    proposer_usage: list[dict] = []
    async with Tracer(jsonl=jsonl, model_name=model_name) as tracer:
        state = Climb(spec, client_kind=client_kind, base=base, model_name=model_name, limit=limit,
                      concurrency=concurrency, benchmarks=chosen, tracer=tracer, max_rounds=max_rounds,
                      max_invocations=max_invocations, max_minutes=max_minutes, p=p)
        repeats = 1 if state.deterministic else 2
        report["leash"] = {"maxRounds": max_rounds, "maxInvocations": max_invocations, "maxMinutes": max_minutes,
                           "selectionCost": state.cost(SELECTION_SPLITS), "testReserve": state.reserve}
        all_runs: list[Run] = []
        evaluations: list[Evaluation] = []
        if not state.fits(repeats * state.cost(SELECTION_SPLITS)):
            report.update(status="inconclusive-leash", converged=False, stoppedBy="invocations",
                          reason=f"the baseline needs {repeats * state.cost(SELECTION_SPLITS)} invocations plus a test "
                                 f"reserve of {state.reserve}; the leash allows {max_invocations}")
            report["leash"].update(used=0, minutes=0.0)
            report["usage"] = {}
            report["stage"] = str(stage)
            _stage(stage, [], None, report)
            return report

        baseline_runs = [await state.run_once("baseline" if i == 0 else "baseline-aa", base, None, SELECTION_SPLITS)
                         for i in range(repeats)]
        all_runs += baseline_runs
        baseline = Evaluation("baseline", base, None, baseline_runs)
        evaluations.append(baseline)

        def aa_net(select: Sequence[str]) -> int:
            if len(baseline_runs) < 2:
                return 0
            inc, other = _index(baseline_runs[0]), _index(baseline_runs[1])
            keys = [k for k, r in inc.items() if r.split in select and not r.error and not other[k].error]
            sign = paired_sign([inc[k].passed for k in keys], [other[k].passed for k in keys])
            return abs(sign["wins"] - sign["losses"])

        base_errors = sum(1 for run in baseline_runs for rs in run.values() for r in rs if r.error)
        base_items = sum(len(rs) for run in baseline_runs for rs in run.values())
        report["baseline"] = {"policy": base.as_json(), "summaries": [summaries(r) for r in baseline_runs],
                              "instructionBytes": state.bytes_of(base, None)}
        if len(baseline_runs) == 2:
            first, second = _index(baseline_runs[0]), _index(baseline_runs[1])
            keys = [k for k in first if not first[k].error and not second[k].error]
            report["baseline"]["aa"] = {**paired_sign([first[k].passed for k in keys], [second[k].passed for k in keys]),
                                        "netSelection": aa_net(SELECTION_SPLITS), "netVal": aa_net(("val",))}

        candidates_report: list[dict] = []
        incumbent = baseline
        overrides: dict[str, Any] = {}
        accepted: list[str] = []
        stopped, non_qualifying, rounds = None, 0, 0
        if base_errors > MAX_ERROR_SHARE * base_items:
            stopped = "infrastructure"
        else:
            for proposal in spec.proposals(client_kind, p):
                if non_qualifying >= MAX_NON_QUALIFYING:
                    stopped = "non-qualifying"
                    break
                if rounds >= max_rounds:
                    stopped = "rounds"
                    break
                if state.minutes() >= max_minutes:
                    stopped = "minutes"
                    break
                cost = state.cost(SELECTION_SPLITS) + (0 if isinstance(proposal, Candidate) else spec.proposer_cost)
                if not state.fits(cost):
                    stopped = "invocations"
                    break
                if isinstance(proposal, Candidate):
                    candidate = proposal
                else:
                    before = state.used
                    candidate = await proposal(ClimbState(spec.name, client_kind, model_name, train_view(incumbent),
                                                          tracer, p, rounds + 1))
                    state.used = before + spec.proposer_cost
                    proposer_usage.append(getattr(proposal, "last_usage", {}) or {})
                if candidate is None:
                    rounds += 1
                    non_qualifying += 1
                    candidates_report.append({"round": rounds, "name": proposal_name(proposal), "qualifies": False,
                                              "reason": getattr(proposal, "last_error", None)
                                              or "the proposer returned no valid candidate"})
                    continue
                merged = {**overrides, **candidate.policy_overrides}
                policy = dataclasses.replace(base, **merged)
                policy.validate()
                procedure = candidate.procedure if candidate.procedure is not None else incumbent.procedure
                if policy == incumbent.policy and procedure == incumbent.procedure:
                    candidates_report.append({"name": candidate.name, "skipped": "no change from the incumbent"})
                    continue
                rounds += 1
                run = await state.run_once(candidate.name, policy, procedure, SELECTION_SPLITS)
                all_runs.append(run)
                evaluation = Evaluation(candidate.name, policy, procedure, [run])
                evaluations.append(evaluation)
                select = ("val",) if candidate.uses_train else SELECTION_SPLITS
                verdict = judge(incumbent.runs, run, select=select, guard=("train",) if candidate.uses_train else (),
                                deterministic=state.deterministic, aa_net=aa_net(select),
                                instruction_bytes=(state.bytes_of(incumbent.policy, incumbent.procedure),
                                                   state.bytes_of(policy, procedure)))
                candidates_report.append({"round": rounds, "name": candidate.name, "description": candidate.description,
                                          "incumbent": incumbent.name, "usesTrain": candidate.uses_train,
                                          "policy": policy.as_json(),
                                          "procedureBytes": len(procedure.encode("utf-8")) if procedure else None,
                                          "summaries": summaries(run), **verdict})
                if verdict["qualifies"]:
                    incumbent, overrides = evaluation, merged
                    accepted.append(candidate.name)
                    non_qualifying = 0
                else:
                    non_qualifying += 1
            else:
                stopped = "non-qualifying" if non_qualifying >= MAX_NON_QUALIFYING else "candidates-exhausted"

        report["candidates"] = candidates_report
        report["accepted"] = accepted
        report["converged"] = stopped in ("non-qualifying", "candidates-exhausted")
        report["stoppedBy"] = stopped

        if stopped == "infrastructure":
            report.update(status="inconclusive-infrastructure",
                          reason=f"{base_errors} of {base_items} baseline items hit infrastructure errors; nothing was judged")
        else:
            base_test = await state.run_once("baseline", base, None, TEST_SPLITS)
            all_runs.append(base_test)
            test: dict[str, Any] = {"baseline": summaries(base_test)}
            held_out_ok = True
            if incumbent is not baseline:
                final_test = await state.run_once(incumbent.name, incumbent.policy, incumbent.procedure, TEST_SPLITS)
                all_runs.append(final_test)
                verdict = judge([base_test], final_test, select=TEST_SPLITS, deterministic=state.deterministic)
                losses = verdict["regressions"] if state.deterministic else (
                    ["net loss"] if verdict["sign"]["losses"] > verdict["sign"]["wins"] else [])
                held_out_ok = not (losses or verdict["guardViolations"] or
                                   len(verdict["excludedForErrors"]) > MAX_ERROR_SHARE * verdict["items"])
                test.update(selected=summaries(final_test), sign=verdict["sign"], regressions=verdict["regressions"],
                            guardViolations=verdict["guardViolations"], excludedForErrors=verdict["excludedForErrors"],
                            confirmed=held_out_ok)
            report["test"] = test
            if incumbent is baseline:
                if stopped in ("rounds", "invocations", "minutes"):
                    report.update(status="inconclusive-leash",
                                  reason=f"the {stopped} leash ran out before any proposal qualified")
                else:
                    report.update(status="no-qualifying-candidate",
                                  reason=next((c.get("reason") for c in reversed(candidates_report) if c.get("reason")),
                                              "no proposal applied"))
            elif not held_out_ok:
                report.update(status="no-qualifying-candidate",
                              reason=f"{incumbent.name} cleared the keep-bar on train/val but regressed on the held-out "
                                     "test split, so nothing is selected")
            else:
                last = next(c for c in reversed(candidates_report) if c.get("name") == incumbent.name and "round" in c)
                note = "" if report["converged"] else f"; the climb did not converge (stopped by {stopped})"
                report.update(status="selected", selected=incumbent.name,
                              reason=f"{' then '.join(accepted)} cleared the keep-bar ({last['criterion']}: "
                                     f"{last['reason']}) and held on the test split{note}")

        report["leash"].update(used=state.used, minutes=round(state.minutes(), 2))
        report["usage"] = total_usage(all_runs, proposer_usage)
        report["stage"] = str(stage)
        _stage(stage, evaluations, incumbent if report["status"] == "selected" else None, report)
    return report
