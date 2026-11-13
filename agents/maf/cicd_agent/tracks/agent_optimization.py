"""Agent optimization: hill-climb orchestration, instruction following, grounding and correctness.

Candidates change only how the model is asked to think: the instructions variant or the reasoning effort. Skills,
tools and policy limits stay fixed. Live runs score chat instruction following (IFEval), code reasoning (CRUXEval-O)
and grounded lint answers; the scripted client can only exercise the behavior and grounding harnesses, so it cannot
select on instructions or reasoning and gets neither kind of candidate it would ignore.
"""
from __future__ import annotations

from ..config import Paths
from .common import Candidate, TrackSpec

REASONING = (
    ("reasoning-low", "low reasoning effort before answering; costs output tokens", "low"),
)

VARIANTS = (
    ("concise", "answer first, fewest words, explicit user formats win"),
    ("grounded", "every stated ID, path and number must come from a tool result"),
    ("orchestrated", "plan evidence first, no repeated calls, page fully, answer once"),
)


def proposals(client_kind: str, p: Paths) -> list[Candidate]:
    reasoning = [] if client_kind == "scripted" else [
        Candidate(name, description, policy_overrides={"reasoning_effort": effort})
        for name, description, effort in REASONING]
    return reasoning + [
        Candidate(name, description, policy_overrides={"instructions_variant": name})
        for name, description in VARIANTS if (p.repo / "agents" / "maf" / "instructions" / f"{name}.md").is_file()]


SPEC = TrackSpec(
    name="agent",
    goal="Improve instruction following (IFEval), code understanding (CRUXEval-O), grounded tool answers and "
         "orchestration efficiency without new hallucinated rule IDs or a stable-check regression.",
    allowed=("behavior", "ifeval", "cruxeval", "grounding"),
    defaults={"scripted": ("behavior", "grounding"), "azure": ("grounding", "ifeval", "cruxeval")},
    proposals=proposals,
)
