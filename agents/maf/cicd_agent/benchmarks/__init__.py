"""Benchmarks the hill-climbing tracks score the agent against.

- ``behavior``: the repository's CI-feedback fixture cases (tool orchestration, grounding, hand-off).
- ``ifeval``: a pinned IFEval subset (Google Research, Apache-2.0) for instruction following in chat.
- ``cruxeval``: a pinned CRUXEval-O subset (Meta, MIT) for code understanding.

Every result is an item-level pass/fail with a reward in [0, 1], so tracks can report Wilson intervals and
paired sign tests on identical items instead of single headline numbers.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from ..stats import wilson


@dataclass
class ItemResult:
    benchmark: str
    item: str
    split: str
    passed: bool
    reward: float
    detail: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, int] = field(default_factory=dict)
    error: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def summarize(results: list[ItemResult]) -> dict:
    """Pass rate with a Wilson 95% interval, mean reward, infrastructure errors and token usage."""
    usage: dict[str, int] = {}
    for result in results:
        for key, value in result.usage.items():
            usage[key] = usage.get(key, 0) + int(value)
    scored = [r for r in results if r.error is None]
    return {
        "pass": wilson(sum(r.passed for r in scored), len(scored)).as_dict(),
        "meanReward": round(sum(r.reward for r in scored) / len(scored), 4) if scored else 0.0,
        "errors": len(results) - len(scored),
        "usage": usage,
    }
