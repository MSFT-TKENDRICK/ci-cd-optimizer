"""Harness policy: tool allowlist, invocation budget, root confinement and result bounds.

The policy is enforced as MAF function middleware, so a model cannot call a tool the policy does not
allow, exceed its budget, or point a tool outside the workspace it was given.
"""
from __future__ import annotations

import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

from agent_framework import (
    Content,
    FunctionInvocationContext,
    FunctionMiddleware,
    MiddlewareFailure,
    MiddlewareTermination,
)

from .config import paths, read_json

READ_ONLY_TOOLS = (
    "lint", "lint_content", "fix_preview", "list_rules", "explain_rule", "effective_config",
    "validate_review_project", "workflow_run_report", "record_disposition", "collect_run_report",
    "load_skill", "read_skill_resource",
)
# Skill scripts execute code; they are never part of the read-only harness, whatever a policy file says.
FORBIDDEN_TOOLS = ("run_skill_script",)


CAMEL_FIELDS = {"allowedTools": "allowed_tools", "maxFunctionCalls": "max_function_calls",
                "maxIterations": "max_iterations", "maxDurationSeconds": "max_duration_seconds",
                "confineRoot": "confine_root", "onViolation": "on_violation",
                "maxToolResultChars": "max_tool_result_chars", "handoffTool": "handoff_tool",
                "skills": "skills", "instructionsVariant": "instructions_variant",
                "reasoningEffort": "reasoning_effort"}
# The OpenAI API's reasoning levels; each deployment accepts a subset and rejects the rest with a 400.
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh")


class PolicyViolation(RuntimeError):
    """Raised before a disallowed call executes; MAF returns it to the model as a tool error."""


@dataclass(frozen=True)
class Policy:
    allowed_tools: tuple[str, ...] = READ_ONLY_TOOLS
    max_function_calls: int = 24
    max_iterations: int = 12
    max_duration_seconds: float = 120.0
    confine_root: bool = True
    on_violation: str = "error"  # "error" lets the model correct itself; "abort" fails the run closed
    max_tool_result_chars: int = 60_000
    handoff_tool: bool = False  # expose the skill-to-code collect_run_report tool
    skills: bool = True  # expose the plugin skills through MAF's SkillsProvider
    instructions_variant: str = "plugin"
    reasoning_effort: str | None = None  # None keeps the deployment's default
    extra: dict = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None, **overrides: Any) -> "Policy":
        data = read_json(path or paths().policy)
        names = {f.name for f in fields(cls)}
        values: dict[str, Any] = {}
        extra: dict[str, Any] = {}
        for key, value in data.items():
            name = CAMEL_FIELDS.get(key, key)
            if name in names and name != "extra":
                values[name] = tuple(value) if name == "allowed_tools" else value
            elif key not in ("$schema", "schema"):
                extra[key] = value
        values.update(overrides)
        values.setdefault("extra", extra)
        policy = cls(**values)
        policy.validate()
        return policy

    def validate(self) -> None:
        unknown = set(self.allowed_tools) - set(READ_ONLY_TOOLS)
        if unknown:
            raise ValueError(f"policy allows tools outside the read-only set: {sorted(unknown)}")
        if self.on_violation not in ("error", "abort"):
            raise ValueError("onViolation must be 'error' or 'abort'")
        if not (1 <= self.max_function_calls <= 120 and 1 <= self.max_iterations <= 60):
            raise ValueError("budgets must stay within the 120-call leash")
        if not 1 <= self.max_duration_seconds <= 2700:
            raise ValueError("maxDurationSeconds must stay within the 45-minute leash")
        if not 1000 <= self.max_tool_result_chars <= 200_000:
            raise ValueError("maxToolResultChars must be between 1000 and 200000")
        if not re.fullmatch(r"[a-z0-9-]{1,40}", self.instructions_variant):
            raise ValueError("instructionsVariant must be a short kebab-case name")
        if self.reasoning_effort is not None and self.reasoning_effort not in REASONING_EFFORTS:
            raise ValueError(f"reasoningEffort must be one of {', '.join(REASONING_EFFORTS)}")

    def chat_options(self) -> dict:
        """Default chat options for every request the agent makes."""
        return {"reasoning_effort": self.reasoning_effort} if self.reasoning_effort else {}

    def as_json(self) -> dict:
        """The policy-file form, so a staged proposal round-trips through ``Policy.load``."""
        data: dict[str, Any] = dict(self.extra)
        for camel, name in CAMEL_FIELDS.items():
            value = getattr(self, name)
            data[camel] = list(value) if isinstance(value, tuple) else value
        return data

    def allows(self, name: str) -> bool:
        if name in FORBIDDEN_TOOLS:
            return False
        # Enabling the skill-to-code hand-off tool is itself the policy decision that allows it.
        return name in self.allowed_tools or (name == "collect_run_report" and self.handoff_tool)

    def invocation_configuration(self) -> dict:
        # Detailed errors let the model see policy reasons and access denials instead of a generic failure.
        # Sequential calls keep the budget and trace order deterministic.
        return {"max_iterations": self.max_iterations, "max_function_calls": self.max_function_calls,
                "max_duration_seconds": self.max_duration_seconds, "include_detailed_errors": True,
                "allow_concurrent_invocation": False}


def _within(candidate: Path, roots: list[Path]) -> bool:
    for root in roots:
        try:
            candidate.relative_to(root)
            return True
        except ValueError:
            continue
    return False


class PolicyMiddleware(FunctionMiddleware):
    def __init__(self, policy: Policy, roots: list[Path] | None = None,
                 on_event: Callable[[dict], None] | None = None, root_tools: tuple[str, ...] = ()) -> None:
        self.policy = policy
        self.roots = [Path(os.path.realpath(r)) for r in (roots or [])]
        self.on_event = on_event or (lambda event: None)
        self.root_tools = root_tools
        self.calls = 0
        self.violations: list[str] = []

    def reset(self) -> None:
        self.calls = 0
        self.violations = []

    def _violate(self, name: str, reason: str) -> None:
        self.violations.append(f"{name}: {reason}")
        self.on_event({"type": "policy_violation", "tool": name, "reason": reason})
        if self.policy.on_violation == "abort":
            raise MiddlewareFailure(f"Harness policy blocked {name}: {reason}")
        raise PolicyViolation(f"Harness policy blocked {name}: {reason}")

    def _confine(self, name: str, arguments: dict) -> None:
        if not self.policy.confine_root or ("root" not in arguments and name not in self.root_tools):
            return
        value = arguments.get("root")
        if not self.roots:
            self._violate(name, "no workspace root is configured for this session")
        if value in (None, "", ".", "./") and len(self.roots) == 1:
            arguments["root"] = str(self.roots[0])
            return
        raw = Path(str(value))
        if not raw.is_absolute():
            raw = self.roots[0] / raw
        if not _within(Path(os.path.realpath(raw)), self.roots):
            self._violate(name, "root is outside the session workspace")
        arguments["root"] = str(raw)

    async def process(self, context: FunctionInvocationContext, call_next) -> None:  # noqa: ANN001
        name = context.function.name
        if not self.policy.allows(name):
            self._violate(name, "tool is not in the policy allowlist")
        self.calls += 1
        if self.calls > self.policy.max_function_calls:
            self.on_event({"type": "policy_budget", "tool": name, "calls": self.calls})
            raise MiddlewareTermination("Tool-call budget exhausted by harness policy.")
        arguments = context.arguments
        if hasattr(arguments, "model_dump"):
            arguments = arguments.model_dump(exclude_none=True)
        arguments = dict(arguments or {})
        self._confine(name, arguments)
        context.arguments = arguments
        started = time.perf_counter()
        error = None
        try:
            await call_next()
        except Exception as exc:  # recorded, then re-raised for MAF's own error handling
            error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            self.on_event({"type": "tool_call", "tool": name, "arguments": dict(context.arguments or {}),
                           "ms": round((time.perf_counter() - started) * 1000, 1), "error": error})
        context.result = self._bound(context.result)

    def _bound(self, result: Any) -> Any:
        limit = self.policy.max_tool_result_chars
        if isinstance(result, str):
            return result if len(result) <= limit else result[:limit] + f"\n[truncated {len(result) - limit} chars by harness policy]"
        if isinstance(result, list):
            texts = [getattr(item, "text", None) for item in result]
            if all(isinstance(t, str) for t in texts) and texts:
                joined = "\n".join(texts)
                if len(joined) > limit:
                    return [Content.from_text(joined[:limit] + f"\n[truncated {len(joined) - limit} chars by harness policy]")]
        return result
