"""CRUXEval-O (Gu et al., 2024; MIT): code understanding by predicting a Python function's output.

The prompt is the reference *direct output* prompt. The answer is the right-hand side of the asserted
equality inside the last ``[ANSWER]`` block, read with ``ast.literal_eval`` and compared with ``==`` to the
recorded output. Neither the dataset code nor the model's answer is ever executed, so an answer that is a
correct but unsimplified expression (which the prompt forbids) fails here although the reference harness,
which executes it, would accept it. Scores are therefore a lower bound on reference pass@1 for this subset.
"""
from __future__ import annotations

import ast
import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ..config import Paths
from ..policy import Policy
from ..tracing import Tracer
from . import ItemResult
from .chat import DATA_DIR, SPLITS, ClientFactory, load_rows, run_items, sha256_file, stable_key, write_jsonl

NAME = "cruxeval"
SOURCE = {"dataset": "cruxeval-org/cruxeval", "revision": "b96af0450242eb4da433032b90998f25588a5d0f",
          "file": "test.jsonl", "license": "MIT",
          "sha256": "8368b81047dc5014e4caf5a2f97604eff7644e0ecd7415e3ceeb184bbc2e0c96"}
MAX_ANSWER_CHARS = 20_000

PROMPT_TEMPLATE = '''You are given a Python function and an assertion containing an input to the function. \
Complete the assertion with a literal (no unsimplified expressions, no function calls) containing the output \
when executing the provided code on the given input, even if the function is incorrect or incomplete. \
Do NOT output any extra information. Provide the full assertion with the correct output in [ANSWER] and \
[/ANSWER] tags, following the examples.

[PYTHON]
def f(n):
    return n
assert f(17) == ??
[/PYTHON]
[ANSWER]
assert f(17) == 17
[/ANSWER]

[PYTHON]
def f(s):
    return s + "a"
assert f("x9j") == ??
[/PYTHON]
[ANSWER]
assert f("x9j") == "x9ja"
[/ANSWER]

[PYTHON]
{code}
assert f({input}) == ??
[/PYTHON]
[ANSWER]
'''

_FENCE = re.compile(r"^\s*```[\w+-]*\s*$", re.MULTILINE)
_MISSING = object()


def prompt(row: dict) -> str:
    return PROMPT_TEMPLATE.format(code=row["code"], input=row["input"])


def answer_text(response: str) -> str:
    """The body of the last [ANSWER] block (or the whole response), without code fences."""
    text = response
    if "[ANSWER]" in text:
        text = text.rsplit("[ANSWER]", 1)[1]
    text = text.split("[/ANSWER]", 1)[0]
    return _FENCE.sub("", text).strip()


def _rhs(node: ast.AST) -> ast.expr | None:
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
        return node.comparators[0]
    return None


def _literal(node: ast.expr | None) -> Any:
    if node is None:
        return _MISSING
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return _MISSING


def _parse(source: str, mode: str) -> ast.AST | None:
    try:
        return ast.parse(source, mode=mode)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None


def extract_answer(response: str) -> Any:
    """The predicted output literal, or ``_MISSING`` when the response holds no parseable answer."""
    text = answer_text(response)
    if not text or len(text) > MAX_ANSWER_CHARS:
        return _MISSING
    module = _parse(text, "exec")
    if module is not None:
        asserts = [node for node in ast.walk(module) if isinstance(node, ast.Assert)]
        if asserts:
            return _literal(_rhs(asserts[-1].test))
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("assert "):
            parsed = _parse(stripped[len("assert "):], "eval")
            if parsed is not None:
                return _literal(_rhs(parsed.body))
    parsed = _parse(text, "eval")
    if parsed is None:
        return _MISSING
    rhs = _rhs(parsed.body)
    return _literal(rhs if rhs is not None else parsed.body)


def grade(row: dict, response: str) -> tuple[bool, float, dict]:
    predicted = extract_answer(response)
    if predicted is _MISSING:
        return False, 0.0, {"parsed": False}
    try:
        passed = bool(predicted == ast.literal_eval(row["output"]))
    except Exception:  # an exotic __eq__ cannot arise from literals; stay defensive anyway
        passed = False
    return passed, 1.0 if passed else 0.0, {"parsed": True, "predicted": repr(predicted)[:500]}


def build_subset(source: Path, out: Path | None = None, n: int = 60) -> str:
    """Deterministic subset: the first ``n`` rows in sha256(id) order, split round-robin."""
    if sha256_file(source) != SOURCE["sha256"]:
        raise ValueError(f"{source} is not the pinned {SOURCE['dataset']}@{SOURCE['revision']} file")
    rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    picked = sorted(rows, key=lambda r: stable_key(r["id"]))[:n]
    subset = [{"id": f"cruxeval-{row['id']}", "key": row["id"], "split": SPLITS[i % len(SPLITS)],
               "code": row["code"], "input": row["input"], "output": row["output"]}
              for i, row in enumerate(picked)]
    return write_jsonl(out or DATA_DIR / f"{NAME}.jsonl", subset)


def load_items(splits: Sequence[str] | None = None, data_dir: Path | None = None) -> list[dict]:
    return load_rows(NAME, splits, data_dir)


async def run(client_factory: ClientFactory, *, policy: Policy, tracer: Tracer, track: str = "baseline",
              candidate: str = "baseline", splits: Sequence[str] | None = None, model_name: str = "unknown",
              p: Paths | None = None, concurrency: int = 4, data_dir: Path | None = None) -> list[ItemResult]:
    return await run_items(NAME, load_items(splits, data_dir), prompt, grade, client_factory, policy=policy,
                           tracer=tracer, track=track, candidate=candidate, model_name=model_name, p=p,
                           concurrency=concurrency)
