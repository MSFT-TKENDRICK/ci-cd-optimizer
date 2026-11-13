import pytest

from cicd_agent.benchmarks import ItemResult, summarize
from cicd_agent.stats import paired_sign, wilson
from cicd_agent.tracks.common import Evaluation, train_view, judge


def test_wilson_matches_known_intervals():
    assert wilson(5, 10).as_dict()["wilson95"] == [0.2366, 0.7634]
    zero = wilson(0, 10)
    assert zero.low == 0.0 and zero.high == pytest.approx(0.2775, abs=1e-4)
    assert wilson(0, 0).as_dict() == {"successes": 0, "n": 0, "rate": 0.0, "wilson95": [0.0, 1.0]}
    with pytest.raises(ValueError):
        wilson(11, 10)


def test_paired_sign():
    assert paired_sign([False] * 5, [True] * 5) == {"wins": 5, "losses": 0, "ties": 0, "p": 0.0625}
    assert paired_sign([True, False], [True, False]) == {"wins": 0, "losses": 0, "ties": 2, "p": 1.0}
    with pytest.raises(ValueError):
        paired_sign([True], [])


def test_summarize_excludes_errors_from_the_rate():
    results = [ItemResult("ifeval", "a", "val", True, 1.0, usage={"requests": 1}),
               ItemResult("ifeval", "b", "val", False, 0.0, usage={"requests": 2}, error="timeout")]
    out = summarize(results)
    assert out["pass"]["n"] == 1 and out["errors"] == 1 and out["usage"] == {"requests": 3}


def item(bench, name, passed, split="val", requests=1, error=None, output=0, **detail):
    return ItemResult(bench, name, split, passed, float(passed), detail=detail,
                      usage={"requests": requests, "output_token_count": output}, error=error)


def run(*results):
    out: dict[str, list] = {}
    for r in results:
        out.setdefault(r.benchmark, []).append(r)
    return out


def verdict(incumbent, candidate, *, deterministic=True, **kwargs):
    return judge(incumbent, candidate, select=("val",), deterministic=deterministic, **kwargs)


def test_deterministic_pass_gain_qualifies():
    base = run(item("behavior", "a", False), item("behavior", "b", True))
    cand = run(item("behavior", "a", True), item("behavior", "b", True))
    out = verdict([base], cand)
    assert out["qualifies"] and out["criterion"] == "pass-gain"


def test_regression_blocks_even_with_net_gain():
    base = run(item("ifeval", "a", False), item("ifeval", "b", False), item("ifeval", "c", True))
    cand = run(item("ifeval", "a", True), item("ifeval", "b", True), item("ifeval", "c", False))
    out = verdict([base], cand)
    assert not out["qualifies"] and out["regressions"] == ["ifeval/c"]


def test_regression_only_counts_items_stable_across_incumbent_runs():
    first = run(item("ifeval", "a", True), item("ifeval", "b", False))
    second = run(item("ifeval", "a", False), item("ifeval", "b", False))
    cand = run(item("ifeval", "a", False), item("ifeval", "b", True))
    assert verdict([first, second], cand)["regressions"] == []


def test_behavior_guard_exempts_style_checks_only():
    base = run(item("behavior", "a", True, checks={"concise": True, "grounded": True}))
    style = run(item("behavior", "a", True, checks={"concise": False, "grounded": True}))
    broken = run(item("behavior", "a", True, checks={"concise": True, "grounded": False}))
    assert verdict([base], style)["guardViolations"] == []
    out = verdict([base], broken)
    assert not out["qualifies"] and out["guardViolations"] == ["a: check grounded newly failed"]


def test_grounding_guard_catches_new_hallucinations():
    base = run(item("grounding", "g", True, requests=4, hallucinated=[], unknownIds=[]))
    cand = run(item("grounding", "g", True, requests=1, hallucinated=["cache/made-up"], unknownIds=["cache/made-up"]))
    out = verdict([base], cand)
    assert not out["qualifies"]
    assert any("new hallucinated" in v for v in out["guardViolations"])
    assert "grounding: unknownIds rose from 0 to 1" in out["guardViolations"]


def test_guard_split_is_checked_but_not_selected():
    base = run(item("behavior", "a", False), item("behavior", "t", True, split="test"))
    cand = run(item("behavior", "a", True), item("behavior", "t", False, split="test"))
    out = judge([base], cand, select=("val",), guard=("test",), deterministic=True)
    assert out["compared"] == 1 and out["regressions"] == ["behavior/t"] and not out["qualifies"]


def test_request_reduction_qualifies_at_equal_behavior():
    base = run(item("behavior", "a", True, requests=10), item("behavior", "b", True, requests=10))
    cand = run(item("behavior", "a", True, requests=4), item("behavior", "b", True, requests=4))
    out = verdict([base], cand)
    assert out["qualifies"] and out["criterion"] == "model-requests" and out["requests"]["reduction"] == 0.6


def test_small_request_reduction_does_not_qualify():
    base = run(item("behavior", "a", True, requests=10))
    cand = run(item("behavior", "a", True, requests=9))
    assert not verdict([base], cand)["qualifies"]


def test_instruction_bytes_qualify_only_live_models():
    base = run(item("ifeval", "a", True))
    cand = run(item("ifeval", "a", True))
    assert not verdict([base], cand, instruction_bytes=(1000, 500))["qualifies"]
    live = verdict([base], cand, deterministic=False, instruction_bytes=(1000, 500))
    assert live["qualifies"] and live["criterion"] == "instruction-bytes"


def test_stochastic_gain_must_beat_the_aa_noise_floor():
    base = run(*(item("ifeval", f"i{n}", False) for n in range(6)))
    cand = run(*(item("ifeval", f"i{n}", True) for n in range(6)))
    assert verdict([base], cand, deterministic=False)["criterion"] == "pass-gain"
    assert not verdict([base], cand, deterministic=False, aa_net=6)["qualifies"]
    few = run(*(item("ifeval", f"i{n}", n < 2) for n in range(6)))
    assert not verdict([base], few, deterministic=False)["qualifies"]


def test_pass_gain_reports_its_output_token_cost():
    base = run(*(item("cruxeval", f"c{n}", False, output=10) for n in range(6)))
    cand = run(*(item("cruxeval", f"c{n}", True, output=50) for n in range(6)))
    out = verdict([base], cand, deterministic=False)
    assert out["criterion"] == "pass-gain"
    assert out["outputTokens"] == {"incumbent": 60, "candidate": 300, "reduction": -4.0}


def test_more_losses_than_wins_blocks_efficiency():
    base = run(item("ifeval", "a", True, requests=10), item("ifeval", "b", True, requests=10),
               item("ifeval", "c", False, requests=10))
    second = run(item("ifeval", "a", True, requests=10), item("ifeval", "b", False, requests=10),
                 item("ifeval", "c", False, requests=10))
    cand = run(item("ifeval", "a", True, requests=1), item("ifeval", "b", False, requests=1),
               item("ifeval", "c", False, requests=1))
    out = verdict([base, second], cand)
    assert not out["qualifies"] and out["reason"] == "1 losses against 0 wins"


def test_infrastructure_errors_block_judging():
    base = run(*(item("ifeval", f"i{n}", False) for n in range(5)))
    cand = run(*(item("ifeval", f"i{n}", True, error="502" if n == 0 else None) for n in range(5)))
    out = verdict([base], cand)
    assert not out["qualifies"] and "infrastructure errors" in out["reason"]
    assert out["excludedForErrors"] == ["ifeval/i0"]


def test_missing_candidate_items_raise():
    with pytest.raises(ValueError):
        verdict([run(item("ifeval", "a", True))], run(item("ifeval", "b", True)))


def test_train_view_keeps_only_train_items():
    evaluation = Evaluation("x", None, None, [run(item("ifeval", "a", True, split="train"), item("ifeval", "b", True))])
    (only,) = train_view(evaluation).runs
    assert [r.item for r in only["ifeval"]] == ["a"]
