"""Small, dependency-free statistics used to report benchmark uncertainty honestly."""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Proportion:
    successes: int
    n: int
    low: float
    high: float

    @property
    def rate(self) -> float:
        return self.successes / self.n if self.n else 0.0

    def as_dict(self) -> dict:
        return {"successes": self.successes, "n": self.n, "rate": round(self.rate, 4),
                "wilson95": [round(self.low, 4), round(self.high, 4)]}


def wilson(successes: int, n: int, z: float = 1.96) -> Proportion:
    """Wilson score interval; well-behaved for small n and rates near 0 or 1."""
    if n <= 0:
        return Proportion(0, 0, 0.0, 1.0)
    if not 0 <= successes <= n:
        raise ValueError("successes must be between 0 and n")
    p = successes / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return Proportion(successes, n, max(0.0, centre - half), min(1.0, centre + half))


def paired_sign(baseline: list[bool], candidate: list[bool]) -> dict:
    """Paired comparison on the same items: wins, losses and an exact two-sided sign-test p-value."""
    if len(baseline) != len(candidate):
        raise ValueError("paired comparison requires equal-length results")
    wins = sum(1 for b, c in zip(baseline, candidate) if c and not b)
    losses = sum(1 for b, c in zip(baseline, candidate) if b and not c)
    trials = wins + losses
    tail = sum(math.comb(trials, k) for k in range(0, min(wins, losses) + 1)) / (2 ** trials) if trials else 1.0
    return {"wins": wins, "losses": losses, "ties": len(baseline) - trials, "p": round(min(1.0, 2 * tail), 4)}
