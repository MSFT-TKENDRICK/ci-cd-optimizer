import pytest

from cicd_agent.benchmarks import cruxeval, grounding
from cicd_agent.policy import Policy
from cicd_agent.runner import items, make_factory


@pytest.mark.parametrize("response,expected", [
    ("[ANSWER]\nassert f('ab') == 'ba'\n[/ANSWER]", "ba"),
    ("thinking...\n[ANSWER]assert f(1) == 2[/ANSWER] then [ANSWER]assert f(1) == [3, 4][/ANSWER]", [3, 4]),
    ("```python\nassert f(x) == {'a': (1, 2)}\n```", {"a": (1, 2)}),
    ("The output is:\nassert f(3) == -1", -1),
    ("'hello'", "hello"),
    ("f(2) == True", True),
])
def test_cruxeval_extracts_the_final_literal(response, expected):
    assert cruxeval.extract_answer(response) == expected


@pytest.mark.parametrize("response", ["", "the answer is probably five", "assert f(1) == g(2)",
                                      "[ANSWER]" + "1" * 20_001 + "[/ANSWER]"])
def test_cruxeval_unparseable_answers_fail(response):
    passed, reward, detail = cruxeval.grade({"output": "5"}, response)
    assert not passed and reward == 0.0 and detail == {"parsed": False}


def test_cruxeval_grades_by_value_not_text():
    assert cruxeval.grade({"output": "[1, 2]"}, "[ANSWER]assert f(x) == [1,2][/ANSWER]")[0]
    assert not cruxeval.grade({"output": "'1'"}, "[ANSWER]assert f(x) == 1[/ANSWER]")[0]


KNOWN = frozenset({"cache/missing-npm-cache", "pinning/unpinned-action", "concurrency/missing-group"})


def test_grounding_exact_section_passes():
    truth = {"cache/missing-npm-cache", "pinning/unpinned-action"}
    text = "Findings mention concurrency/missing-group in passing.\n\nRule IDs: cache/missing-npm-cache, pinning/unpinned-action"
    passed, f1, detail = grounding.grade(truth, text, KNOWN)
    assert passed and f1 == 1.0 and detail["hasSection"] and detail["hallucinated"] == []


def test_grounding_counts_hallucinated_and_unknown_ids():
    passed, f1, detail = grounding.grade({"cache/missing-npm-cache"},
                                         "Rule IDs: cache/missing-npm-cache, cache/made-up", KNOWN)
    assert not passed and f1 == pytest.approx(0.6667)
    assert detail["hallucinated"] == ["cache/made-up"] and detail["unknownIds"] == ["cache/made-up"]


def test_grounding_without_a_section_only_counts_catalog_ids():
    passed, _, detail = grounding.grade({"pinning/unpinned-action"},
                                        "Fix pinning/unpinned-action; see docs/agents.md and and/or notes.", KNOWN)
    assert passed and not detail["hasSection"] and detail["reported"] == ["pinning/unpinned-action"]


def test_grounding_clean_repository_with_no_ids_passes():
    assert grounding.grade(set(), "Rule IDs: none", KNOWN)[:2] == (True, 1.0)


@pytest.mark.parametrize("bench,kind", [("nope", "scripted"), ("ifeval", "scripted"), ("cruxeval", "scripted"),
                                        ("behavior", "openai")])
def test_make_factory_rejects_unsupported_routes(bench, kind):
    with pytest.raises(ValueError):
        make_factory(bench, kind, Policy())


def test_items_limit_applies_per_split():
    rows = items("ifeval", limit=2)
    assert len(rows) == 6 and {r["split"] for r in rows} == {"train", "val", "test"}
    assert len(items("cruxeval", ("val",), limit=3)) == 3
    with pytest.raises(ValueError):
        items("ifeval", limit=0)
    with pytest.raises(ValueError):
        items("unknown")
