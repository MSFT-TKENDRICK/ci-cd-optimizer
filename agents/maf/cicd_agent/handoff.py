"""Skill-to-code: exact-attempt report collection, disposition derivation and the 80-word handoff.

`analyze-ci-run` and `benchmark-feedback.md` describe these steps as prose: follow every report page and
finding-evidence cursor for one exact run attempt, keep execution, queue-inclusive and runner time separate,
treat savings as overlapping bounds, and hand off in at most 80 words that link only tool-supplied URLs.
The harness-optimization track measures whether exposing these deterministic functions as tools beats
leaving the model to follow the prose.

Report content is untrusted. Only numbers, identifiers and enumerated categories flow into a handoff;
free text from a report (warnings, gap details, recommendations) is never copied verbatim.
"""
from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

MAX_WORDS = 80
MAX_REPORT_CALLS = 60
SECTIONS = (  # (pages key, request offset, container path, list field)
    ("jobs", "jobOffset", (), "jobs"),
    ("steps", "stepOffset", (), "slowestSteps"),
    ("bottlenecks", "findingOffset", ("attribution",), "bottlenecks"),
    ("gaps", "gapOffset", ("attribution",), "gaps"),
)
STATUSES = ("actionable", "incomplete", "blocked", "no-action")
_URL = re.compile(r"https?://[^\s<>\"()]+")
_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$")

ReportCall = Callable[[dict[str, Any]], Awaitable[tuple[bool, str]]]
"""Calls workflow_run_report with the given arguments; returns (is_error, text)."""


class ReportDenied(RuntimeError):
    pass


@dataclass
class CollectedReport:
    repo: str
    run_id: int
    run_attempt: int
    denied: bool = False
    error: str | None = None
    run: dict = field(default_factory=dict)
    analysis_status: str | None = None
    jobs_complete: bool | None = None
    jobs: dict[str, dict] = field(default_factory=dict)
    steps: dict[str, dict] = field(default_factory=dict)
    findings: dict[str, dict] = field(default_factory=dict)
    gaps: dict[str, dict] = field(default_factory=dict)
    totals: dict[str, int] = field(default_factory=dict)
    critical_slack_ms: int | None = None
    calls: list[dict] = field(default_factory=list)
    collection_gaps: list[str] = field(default_factory=list)

    def coverage(self) -> dict[str, dict[str, int]]:
        seen = {"jobs": self.jobs, "steps": self.steps, "bottlenecks": self.findings, "gaps": self.gaps}
        return {name: {"collected": len(seen[name]), "total": self.totals.get(name, len(seen[name]))} for name in seen}


def _safe_token(value: Any, fallback: str = "unknown") -> str:
    text = str(value) if value is not None else ""
    return text if _TOKEN.match(text) else fallback


def _container(report: dict, path: tuple[str, ...]) -> dict:
    node = report
    for key in path:
        node = node.get(key) or {}
    return node


def _key(section: str, item: dict, index: int) -> str:
    if section == "jobs":
        return str(item.get("key") or item.get("id") or item.get("name") or index)
    if section == "steps":
        return f'{item.get("job")}/{item.get("step")}/{index}'
    if section == "bottlenecks":
        return str(item.get("id") or index)
    return f'{item.get("kind")}/{item.get("jobKey")}/{index}'


def _merge(collected: CollectedReport, report: dict, offsets: dict[str, int], evidence_offset: int) -> None:
    run = report.get("run") or {}
    if run and not collected.run:
        collected.run = run
    collected.analysis_status = report.get("analysisStatus", collected.analysis_status)
    provenance = report.get("provenance") or {}
    if "jobsComplete" in provenance:
        collected.jobs_complete = bool(provenance["jobsComplete"])
    attribution = report.get("attribution") or {}
    if "criticalSlackMs" in attribution:
        collected.critical_slack_ms = attribution["criticalSlackMs"]
    pages = report.get("pages") or {}
    store = {"jobs": collected.jobs, "steps": collected.steps, "bottlenecks": collected.findings, "gaps": collected.gaps}
    for section, request_key, path, list_field in SECTIONS:
        items = _container(report, path).get(list_field) or []
        page = pages.get(section) or {}
        if isinstance(page.get("total"), int):
            collected.totals[section] = page["total"]
        start = page.get("offset", offsets.get(request_key, 0)) or 0
        for index, item in enumerate(items):
            key = _key(section, item, start + index)
            if section == "bottlenecks":
                existing = store[section].setdefault(key, {**item, "evidence": {}})
                for slot, entry in enumerate(item.get("evidence") or []):
                    existing["evidence"][evidence_offset + slot] = entry
                existing["evidenceTotal"] = item.get("evidenceTotal", len(existing["evidence"]))
            else:
                store[section].setdefault(key, item)


async def collect_report(call: ReportCall, repo: str, run_id: int, run_attempt: int,
                         *, max_calls: int = MAX_REPORT_CALLS) -> CollectedReport:
    """Walk every report page and every finding-evidence cursor for exactly one run attempt.

    A denial ends collection after one call (no alternate identities or retries). Pages are advanced in
    lockstep; each new findings page is followed through all of its evidence cursors.
    """
    collected = CollectedReport(repo=repo, run_id=int(run_id), run_attempt=int(run_attempt))
    offsets = {request_key: 0 for _, request_key, _, _ in SECTIONS}
    finished: set[str] = set()
    finding_pages: set[int] = set()

    async def fetch(evidence_offset: int) -> dict | None:
        if len(collected.calls) >= max_calls:
            collected.collection_gaps.append("report-call budget exhausted before every page was read")
            return None
        args: dict[str, Any] = {"repo": repo, "runId": int(run_id), "runAttempt": int(run_attempt)}
        args.update({k: v for k, v in offsets.items() if v})
        if evidence_offset:
            args["evidenceOffset"] = evidence_offset
        collected.calls.append(dict(args))
        is_error, text = await call(args)
        if is_error:
            collected.denied = "denied" in text.lower()
            collected.error = "access denied" if collected.denied else "report tool error"
            return None
        try:
            report = json.loads(text)
        except ValueError:
            collected.error = "report was not JSON"
            return None
        run = report.get("run") or {}
        if run.get("id") not in (None, int(run_id)) or run.get("attempt") not in (None, int(run_attempt)):
            collected.error = "report identity did not match the requested attempt"
            return None
        _merge(collected, report, offsets, evidence_offset)
        return report

    while True:
        report = await fetch(0)
        if report is None:
            break
        page = offsets["findingOffset"]
        if page not in finding_pages:
            finding_pages.add(page)
            evidence = _next_evidence(report)
            while evidence is not None:
                follow = await fetch(evidence)
                if follow is None:
                    break
                evidence = _next_evidence(follow)
            if collected.error:
                break
        pages = report.get("pages") or {}
        for section, request_key, _, _ in SECTIONS:
            next_offset = (pages.get(section) or {}).get("nextOffset")
            if next_offset is None:
                finished.add(section)
            else:
                offsets[request_key] = int(next_offset)
        if len(finished) == len(SECTIONS) or collected.collection_gaps:
            break
    return collected


def _next_evidence(report: dict) -> int | None:
    cursors = [f.get("nextEvidenceOffset") for f in (report.get("attribution") or {}).get("bottlenecks") or []]
    cursors = [c for c in cursors if isinstance(c, int)]
    return min(cursors) if cursors else None


def _number(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def derive_disposition(collected: CollectedReport) -> dict:
    """The numeric conclusion: separate metrics, an overlapping bound, and never a measured saving."""
    base = {"runId": collected.run_id, "runAttempt": collected.run_attempt, "measuredElapsedSavingsMs": None}
    if collected.denied or collected.error:
        return {**base, "status": "blocked", "executionMs": None, "queueInclusiveMs": None,
                "runnerMs": None, "elapsedSavingsBoundMs": None}
    execution = _number(collected.run.get("durationMs"))
    queue = _number(collected.run.get("queueMs"))
    durations = [_number(job.get("durationMs")) for job in collected.jobs.values()]
    runner = sum(d for d in durations if d is not None) if any(d is not None for d in durations) else None
    coverage = collected.coverage()
    incomplete = (collected.analysis_status not in (None, "complete") or collected.jobs_complete is False
                  or bool(collected.gaps) or bool(collected.collection_gaps)
                  or any(c["collected"] < c["total"] for c in coverage.values()))
    if incomplete:
        status = "incomplete"
    elif collected.findings:
        status = "actionable"
    else:
        status = "no-action"
    bound = _number(collected.critical_slack_ms) if collected.findings else None
    return {**base, "status": status, "executionMs": execution,
            "queueInclusiveMs": execution + queue if execution is not None and queue is not None else None,
            "runnerMs": runner, "elapsedSavingsBoundMs": bound}


def _seconds(ms: int | None) -> str:
    return f"{ms / 1000:.1f} s"


def _strongest(collected: CollectedReport) -> dict | None:
    if not collected.findings:
        return None
    return max(collected.findings.values(),
               key=lambda f: (_number(f.get("elapsedSavingsBoundMs")) or 0, _number(f.get("observedMs")) or 0))


def report_url(collected: CollectedReport) -> str | None:
    url = collected.run.get("url")
    return url if isinstance(url, str) and re.fullmatch(r"https://[^\s<>\"()]+", url) else None


def compose_summary(collected: CollectedReport, disposition: dict, *, change_state: str = "proposed") -> str:
    """At most 80 words: identity, conclusion, strongest finding or blocking gap, change state, next action."""
    identity = f"{_safe_token(collected.repo)} run {collected.run_id} attempt {collected.run_attempt}"
    status = disposition["status"]
    metrics = []
    if disposition["executionMs"] is not None:
        metrics.append(f"execution {_seconds(disposition['executionMs'])}")
    if disposition["queueInclusiveMs"] is not None:
        metrics.append(f"queue-inclusive {_seconds(disposition['queueInclusiveMs'])}")
    if disposition["runnerMs"] is not None:
        metrics.append(f"observed runner work {_seconds(disposition['runnerMs'])}")
    metric_text = ("; ".join(metrics) + ".") if metrics else ""
    url = report_url(collected)
    parts: list[str]
    if status == "blocked":
        parts = [f"{identity}: blocked. The report for this exact attempt was not available ({collected.error or 'unavailable'});",
                 "no metrics or savings were inferred and no change was made.",
                 "Next: rerun analysis with existing authorized access to this exact attempt."]
    elif status == "incomplete":
        kinds = sorted({f"{_safe_token(g.get('kind'), 'gap')} on {_safe_token(g.get('jobKey'), 'a job')}" for g in collected.gaps.values()})
        gap = ", ".join(kinds[:3]) if kinds else (collected.collection_gaps[0] if collected.collection_gaps else "partial analysis")
        parts = [f"{identity}: incomplete. Blocking gap: {gap}.",
                 metric_text.replace("observed runner work", "collected runner work") if metric_text else "",
                 "Unavailable metrics are unknown, not zero; no savings estimate and no change made.",
                 "Next: recollect the missing jobs and logs, then repeat the analysis."]
    elif status == "actionable":
        finding = _strongest(collected) or {}
        category = _safe_token(finding.get("category"), "finding")
        job = _safe_token(finding.get("jobName") or finding.get("jobKey"), "a job")
        observed = _number(finding.get("observedMs"))
        bound = disposition["elapsedSavingsBoundMs"]
        runner_bound = _number(finding.get("runnerSavingsBoundMs"))
        if bound == 0:
            bound_text = "elapsed savings bound 0 s (off the critical path)"
            if runner_bound:
                bound_text += f"; runner savings up to {_seconds(runner_bound)}"
        else:
            bound_text = f"elapsed savings bound up to {_seconds(bound)}" if bound is not None else "no elapsed bound reported"
        observed_text = f", observed {_seconds(observed)}" if observed is not None else ""
        parts = [f"{identity}: actionable. Strongest finding: {category} in {job}{observed_text}; {bound_text}, overlapping, not measured.",
                 metric_text,
                 f"Change {change_state}, not validated." if change_state != "validated" else "Change validated.",
                 "Next: apply the fix without weakening assertions, then compare an interleaved rerun."]
    else:
        parts = [f"{identity}: no action. Complete analysis found no actionable bottleneck; no savings estimate.",
                 metric_text, "No change made. Next: keep collecting comparable runs before optimizing."]
    if url:
        parts.append(f"Report: {url}")
    return fit_words(" ".join(p for p in parts if p))


def fit_words(text: str, limit: int = MAX_WORDS) -> str:
    words = text.split()
    if len(words) <= limit:
        return " ".join(words)
    return " ".join(words[:limit - 1]) + " …"


def validate_summary(summary: str, allowed_urls: tuple[str, ...] = ()) -> list[str]:
    problems = []
    count = len(summary.split())
    if not 5 <= count <= MAX_WORDS:
        problems.append(f"summary has {count} words; expected 5-{MAX_WORDS}")
    for url in _URL.findall(summary):
        if url.rstrip(".,;") not in allowed_urls:
            problems.append(f"summary links a URL no tool supplied: {url}")
    if re.search(r"\bmeasured (?:elapsed )?savings? of\b", summary, re.I):
        problems.append("summary claims measured savings")
    return problems


def handoff(collected: CollectedReport, *, change_state: str = "proposed") -> dict:
    disposition = derive_disposition(collected)
    summary = compose_summary(collected, disposition, change_state=change_state)
    allowed = (report_url(collected),) if report_url(collected) else ()
    problems = validate_summary(summary, allowed)
    if problems:  # composed text must always satisfy its own contract
        raise AssertionError(problems)
    strongest = _strongest(collected)
    return {
        "disposition": {**disposition, "summary": summary},
        "coverage": collected.coverage(),
        "reportCalls": len(collected.calls),
        "strongestFinding": None if strongest is None else {
            "id": _safe_token(strongest.get("id")), "category": _safe_token(strongest.get("category")),
            "job": _safe_token(strongest.get("jobName") or strongest.get("jobKey")),
            "observedMs": _number(strongest.get("observedMs")),
            "elapsedSavingsBoundMs": _number(strongest.get("elapsedSavingsBoundMs")),
            "evidenceCollected": len(strongest.get("evidence") or {}),
            "evidenceTotal": strongest.get("evidenceTotal")},
        "gaps": sorted({f"{_safe_token(g.get('kind'), 'gap')}:{_safe_token(g.get('jobKey'), 'job')}" for g in collected.gaps.values()}),
        "collectionGaps": list(collected.collection_gaps),
        "error": collected.error,
    }
