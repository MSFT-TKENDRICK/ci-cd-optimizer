"""IFEval grader parity: every golden verdict was produced by the upstream reference harness (google-research
instruction_following_eval) for the same row and response, so a mismatch here is a grader bug."""
import json
from pathlib import Path

import pytest

from cicd_agent.benchmarks import ifeval
from cicd_agent.benchmarks.chat import load_rows

GOLDEN = Path(__file__).parent / "data" / "ifeval_golden.jsonl"
ROWS = {row["id"]: row for row in load_rows("ifeval")}
VECTORS = [json.loads(line) for line in GOLDEN.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_every_subset_row_is_gradable():
    assert len(ROWS) == 60
    assert all(ifeval.eligible(row) for row in ROWS.values())
    assert {i for row in ROWS.values() for i in row["instruction_id_list"]} <= ifeval.SUPPORTED


def test_golden_vectors_cover_every_checker_both_ways():
    seen: dict[str, set[bool]] = {}
    for vector in VECTORS:
        for instruction, verdict in zip(ROWS[vector["id"]]["instruction_id_list"], vector["expected"]):
            seen.setdefault(instruction, set()).add(verdict)
    assert set(seen) == ifeval.SUPPORTED
    assert all(verdicts == {True, False} for verdicts in seen.values()), seen


@pytest.mark.parametrize("vector", VECTORS, ids=[f"{v['id']}#{n}" for n, v in enumerate(VECTORS)])
def test_grader_matches_reference(vector):
    row = ROWS[vector["id"]]
    passed, reward, detail = ifeval.grade(row, vector["response"])
    assert [ok for _, ok in detail["instructions"]] == vector["expected"]
    assert passed == all(vector["expected"])
    assert reward == pytest.approx(sum(vector["expected"]) / len(vector["expected"]), abs=1e-4)


@pytest.mark.parametrize("row_id", sorted(ROWS))
def test_empty_response_fails_every_instruction(row_id):
    passed, reward, detail = ifeval.grade(ROWS[row_id], "")
    assert not passed and reward == 0.0
    assert not any(ok for _, ok in detail["instructions"])
