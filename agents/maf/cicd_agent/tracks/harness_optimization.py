"""Harness optimization: hill-climb the plugin wiring and policy the agent runs inside.

Candidates convert a skill procedure to code (the ``collect_run_report`` tool), drop or keep skill loading, and
tighten the tool-call and result-size policy. Nothing here weakens root confinement, the forbidden-tool list or
the violation mode: ``Policy.validate`` rejects those, and the judge's guards reject new hallucinations.
"""
from __future__ import annotations

from ..config import Paths
from .common import Candidate, TrackSpec

CANDIDATES = (
    Candidate("handoff-tool", "convert the run-report paging procedure into the collect_run_report tool",
              policy_overrides={"handoff_tool": True}),
    Candidate("no-skills", "stop loading plugin skills into the context", policy_overrides={"skills": False}),
    Candidate("tight-budget", "halve the tool-call budget and iteration cap",
              policy_overrides={"max_function_calls": 12, "max_iterations": 8}),
    Candidate("smaller-results", "clip tool results at 20,000 characters instead of 60,000",
              policy_overrides={"max_tool_result_chars": 20000}),
)


def proposals(client_kind: str, p: Paths) -> list[Candidate]:
    return list(CANDIDATES)


SPEC = TrackSpec(
    name="harness",
    goal="Cut model requests and context for the same graded outcomes by evolving tools, skills and policy, "
         "without loosening confinement or guards.",
    allowed=("behavior", "grounding"),
    defaults={"scripted": ("behavior", "grounding"), "azure": ("behavior", "grounding")},
    proposals=proposals,
)
