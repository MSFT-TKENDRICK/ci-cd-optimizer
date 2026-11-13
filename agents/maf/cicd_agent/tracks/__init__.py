"""The three hill-climbing tracks, kept separate so each optimizes one layer with the others held fixed."""
from __future__ import annotations

from typing import Any

from . import agent_optimization, harness_optimization, skill_evolution
from .common import climb

SPECS = {"skill": skill_evolution.SPEC, "agent": agent_optimization.SPEC, "harness": harness_optimization.SPEC}
TRACKS = tuple(SPECS)


async def run_track(track: str, **kwargs: Any) -> dict:
    if track not in SPECS:
        raise ValueError(f"unknown track {track!r}; choose from {', '.join(TRACKS)}")
    return await climb(SPECS[track], **kwargs)
