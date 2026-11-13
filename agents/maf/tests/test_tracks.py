import asyncio
import dataclasses

import pytest

from cicd_agent.config import paths, strip_frontmatter
from cicd_agent.policy import Policy
from cicd_agent.tracks import SPECS, TRACKS, run_track
from cicd_agent.tracks.common import resolve_benchmarks
from cicd_agent.tracks.harness_optimization import CANDIDATES
from cicd_agent.tracks.skill_evolution import CHECKLIST, COMPACT, contract_violations


def test_unknown_track_is_rejected():
    with pytest.raises(ValueError):
        asyncio.run(run_track("everything"))


def test_tracks_separate_responsibilities():
    assert TRACKS == ("skill", "agent", "harness")
    assert SPECS["skill"].allowed == ("behavior",)
    assert {"ifeval", "cruxeval"} <= set(SPECS["agent"].allowed)
    assert "ifeval" not in SPECS["harness"].allowed and "cruxeval" not in SPECS["harness"].allowed


def test_harness_candidates_stay_inside_the_policy_envelope():
    base = Policy()
    for candidate in CANDIDATES:
        policy = dataclasses.replace(base, **candidate.policy_overrides)
        policy.validate()
        assert policy.confine_root and policy.on_violation == base.on_violation


def test_agent_candidates_only_change_how_the_model_thinks():
    live = SPECS["agent"].proposals("azure", paths())
    assert live[0].name == "reasoning-low" and live[0].policy_overrides == {"reasoning_effort": "low"}
    for candidate in live:
        assert set(candidate.policy_overrides) <= {"instructions_variant", "reasoning_effort"}
        assert len(candidate.policy_overrides) == 1 and candidate.procedure is None
        dataclasses.replace(Policy(), **candidate.policy_overrides).validate()
    scripted = SPECS["agent"].proposals("scripted", paths())
    assert all("reasoning_effort" not in c.policy_overrides for c in scripted)


def test_skill_proposals_use_reflection_only_with_a_model():
    assert [c.name for c in SPECS["skill"].proposals("scripted", paths())] == ["compact", "checklist"]
    assert [c.name for c in SPECS["skill"].proposals("azure", paths())] == ["reflect-r1", "compact", "reflect-r2",
                                                                            "checklist"]


def test_procedures_keep_the_safety_contract():
    committed = strip_frontmatter(paths().feedback_procedure.read_text(encoding="utf-8"))
    for text in (committed, COMPACT, CHECKLIST):
        assert contract_violations(text) == []
    broken = COMPACT.replace("never change graders", "tune graders").replace("80 words", "200 words")
    assert contract_violations(broken) == ["handoff-limit", "graders-fixed"]


@pytest.mark.parametrize("track,kind,requested", [
    ("skill", "scripted", ["grounding"]),
    ("agent", "scripted", ["ifeval"]),
    ("agent", "azure", ["grounding", "grounding"]),
    ("harness", "azure", ["ifeval"]),
])
def test_resolve_benchmarks_rejects_invalid_requests(track, kind, requested):
    with pytest.raises(ValueError):
        resolve_benchmarks(SPECS[track], kind, requested)


def test_resolve_benchmarks_defaults_by_client():
    assert resolve_benchmarks(SPECS["agent"], "scripted", None) == ["behavior", "grounding"]
    assert resolve_benchmarks(SPECS["agent"], "azure", None) == ["grounding", "ifeval", "cruxeval"]
    assert resolve_benchmarks(SPECS["agent"], "azure", []) == ["grounding", "ifeval", "cruxeval"]
