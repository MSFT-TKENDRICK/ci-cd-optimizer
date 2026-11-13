"""Locations and environment-driven settings shared by the agent, server and benchmarks."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
MAF_DIR = PACKAGE_DIR.parent


def repo_root() -> Path:
    override = os.environ.get("CICD_AGENT_REPO_ROOT")
    return Path(override).resolve() if override else MAF_DIR.parents[1]


@dataclass(frozen=True)
class Paths:
    repo: Path

    @property
    def plugin(self) -> Path:
        return self.repo / "plugins" / "ci-cd-optimizer"

    @property
    def mcp_bundle(self) -> Path:
        return self.plugin / "server" / "cicd-agents.mjs"

    @property
    def agent_definition(self) -> Path:
        return self.plugin / "com.github.copilot" / "agents" / "ci-cd-optimizer.agent.md"

    @property
    def skills(self) -> Path:
        return self.plugin / "skills"

    @property
    def feedback_procedure(self) -> Path:
        return self.skills / "optimize-ci-pipeline" / "references" / "benchmark-feedback.md"

    @property
    def fixture_server(self) -> Path:
        return self.repo / "evals" / "feedback" / "fixture-server.mjs"

    @property
    def behavior_cases(self) -> Path:
        return self.repo / "evals" / "feedback" / "behavior-cases.json"

    @property
    def feedback_harness(self) -> Path:
        return self.repo / "scripts" / "feedback-harness.mjs"

    @property
    def policy(self) -> Path:
        return Path(os.environ.get("CICD_AGENT_POLICY", MAF_DIR / "policy.json"))


def paths() -> Paths:
    return Paths(repo_root())


_FRONTMATTER = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.S)


def strip_frontmatter(text: str) -> str:
    return _FRONTMATTER.sub("", text, count=1).strip()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
