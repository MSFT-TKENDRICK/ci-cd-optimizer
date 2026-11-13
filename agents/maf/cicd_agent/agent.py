"""The CI/CD Optimizer agent on Microsoft Agent Framework.

The agent reuses the plugin's own definition, skills and MCP server, so the Copilot plugin and this agent
share one source of truth. Microsoft Agent Framework (MAF) orchestrates the model loop. The harness policy
runs as MAF function middleware. Agent Lightning records every model call, tool call and reward.
"""
from __future__ import annotations

import json
import os
import shutil
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

from agent_framework import Agent, MCPStdioTool, SkillsProvider, tool
from agent_framework._tools import normalize_function_invocation_configuration
from agent_framework.exceptions import ToolExecutionException

from .config import Paths, paths, strip_frontmatter
from .handoff import collect_report, handoff
from .policy import FORBIDDEN_TOOLS, Policy, PolicyMiddleware
from .tracing import Episode, EpisodeRef, TracingChatMiddleware

# Bundle tools that read the workspace; the harness injects and confines their `root` argument.
ROOT_TOOLS = ("lint", "lint_content", "fix_preview", "list_rules", "explain_rule", "effective_config",
              "validate_review_project")

HARNESS_NOTE = """Harness: Microsoft Agent Framework runtime (read-only).
- This session has no file edit, shell, network or git tool. Propose changes as `fix_preview` diffs or exact text, and never claim a file was edited, a command was run or CI was triggered.
- The workspace root is {root}. Pass it as `root`; the harness rejects any other root.
- Tool budget: at most {calls} tool calls. Spend them on evidence the answer needs.
- Answer in plain Markdown. Cite rule IDs, files and numbers exactly as the tools returned them, and say what you could not verify."""

FIXTURE_NOTE = """Harness: Microsoft Agent Framework runtime (read-only, offline fixture).
- Only the report tools in this session are available. No repository changes or external calls.
- Tool budget: at most {calls} tool calls."""

HANDOFF_TOOL_NOTE = """- `collect_run_report` pages through every jobs, steps, findings, gaps and evidence page of one exact run attempt and returns a validated disposition draft. Prefer it to manual paging, check its coverage, then record or report the disposition it returns."""

CHAT_NOTE = """Harness: Microsoft Agent Framework runtime (chat). This turn has no tools; answer from the message itself."""


def variant_text(policy: Policy, p: Paths) -> str | None:
    """The optional instructions variant the agent-optimization track mutates; ``plugin`` adds nothing."""
    if policy.instructions_variant == "plugin":
        return None
    return (p.repo / "agents" / "maf" / "instructions" / f"{policy.instructions_variant}.md").read_text(
        encoding="utf-8").strip()


def instructions(policy: Policy, p: Paths, *, root: Path | None, fixture: bool) -> str:
    base = strip_frontmatter(p.agent_definition.read_text(encoding="utf-8"))
    note = (FIXTURE_NOTE if fixture else HARNESS_NOTE).format(root=root, calls=policy.max_function_calls)
    parts = [base, note]
    if policy.handoff_tool:
        parts.append(HANDOFF_TOOL_NOTE)
    extra = variant_text(policy, p)
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)


def chat_instructions(policy: Policy, p: Paths) -> str:
    parts = [strip_frontmatter(p.agent_definition.read_text(encoding="utf-8")), CHAT_NOTE]
    extra = variant_text(policy, p)
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)


class ReadOnlySkillsProvider(SkillsProvider):
    """MAF always registers ``run_skill_script``; this harness never advertises tools that execute code."""

    def _create_tools(self, skills):  # noqa: ANN001, ANN202 - framework signature
        return [t for t in super()._create_tools(skills) if t.name not in FORBIDDEN_TOOLS]


def _text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        return "".join(getattr(item, "text", None) or "" for item in result)
    return str(result)


def report_tool(mcp: MCPStdioTool):
    """Skill-to-code: the analyze-ci-run paging and disposition procedure as one deterministic tool."""

    async def call(args: dict) -> tuple[bool, str]:
        try:
            return False, _text(await mcp.call_tool("workflow_run_report", **args))
        except ToolExecutionException as error:
            return True, str(error)

    @tool(name="collect_run_report", approval_mode="never_require")
    async def collect_run_report(
        repo: Annotated[str, "owner/name of the repository"],
        run_id: Annotated[int, "Exact workflow run ID"],
        run_attempt: Annotated[int, "Exact run attempt"],
    ) -> str:
        """Collect every page of one exact workflow run attempt and draft a validated disposition."""
        collected = await collect_report(call, repo, int(run_id), int(run_attempt))
        return json.dumps(handoff(collected), ensure_ascii=False)

    return collect_run_report


@dataclass
class AgentSession:
    agent: Agent
    policy: Policy
    policy_middleware: PolicyMiddleware
    episode_ref: EpisodeRef
    mcp: MCPStdioTool
    root: Path | None
    tool_names: list[str] = field(default_factory=list)

    async def run(self, prompt: str, episode: Episode | None = None):
        self.policy_middleware.reset()
        self.episode_ref.current = episode
        try:
            response = await self.agent.run(prompt)
        finally:
            self.episode_ref.current = None
        if episode is not None:
            episode.record("agent_response", {"text": response.text,
                                              "violations": list(self.policy_middleware.violations)})
        return response


@dataclass
class ChatSession:
    """The same agent persona with no tools: what chat and code-understanding benchmarks measure."""

    agent: Agent
    episode_ref: EpisodeRef

    async def run(self, prompt: str, episode: Episode | None = None):
        self.episode_ref.current = episode
        try:
            response = await self.agent.run(prompt)
        finally:
            self.episode_ref.current = None
        if episode is not None:
            episode.record("agent_response", {"text": response.text})
        return response


def build_chat_agent(client: Any, *, policy: Policy | None = None, model_name: str = "unknown",
                     p: Paths | None = None) -> ChatSession:
    p = p or paths()
    policy = policy or Policy.load()
    episode_ref = EpisodeRef()
    agent = Agent(client, chat_instructions(policy, p), name="ci-cd-optimizer",
                  middleware=[TracingChatMiddleware(episode_ref, model_name)],
                  default_options=policy.chat_options() or None)
    return ChatSession(agent, episode_ref)


@asynccontextmanager
async def build_agent(client: Any, *, root: Path | None = None, fixture: tuple[Path, Path] | None = None,
                      policy: Policy | None = None, model_name: str = "unknown",
                      p: Paths | None = None) -> AsyncIterator[AgentSession]:
    """Start the MCP server and yield a ready agent. ``fixture`` is (fixture.json, trace.jsonl)."""
    p = p or paths()
    policy = policy or Policy.load()
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22+ is required for the CI/CD Optimizer MCP tools")
    if fixture:
        mcp = MCPStdioTool("ci_fixture", node, args=[str(p.fixture_server), str(fixture[0]), str(fixture[1])],
                           load_prompts=False, approval_mode="never_require", request_timeout=60)
        roots: list[Path] = []
    else:
        if root is None:
            raise ValueError("a workspace root is required outside fixture mode")
        root = Path(os.path.realpath(root))
        mcp = MCPStdioTool("ci_cd_optimizer", node, args=[str(p.mcp_bundle), "mcp"], load_prompts=False,
                           approval_mode="never_require", request_timeout=120,
                           allowed_tools=[t for t in policy.allowed_tools if t in ROOT_TOOLS])
        roots = [root]
    episode_ref = EpisodeRef()
    policy_middleware = PolicyMiddleware(policy, roots, on_event=episode_ref.record, root_tools=ROOT_TOOLS)
    async with AsyncExitStack() as stack:
        await stack.enter_async_context(mcp)
        tools: list[Any] = [mcp]
        if fixture and policy.handoff_tool:
            tools.append(report_tool(mcp))
        providers = []
        if policy.skills:
            providers.append(ReadOnlySkillsProvider.from_paths(
                p.skills, script_extensions=(), disable_load_skill_approval=True,
                disable_read_skill_resource_approval=True))
        client.function_invocation_configuration = normalize_function_invocation_configuration(
            policy.invocation_configuration())
        agent = Agent(client, instructions(policy, p, root=root, fixture=bool(fixture)), name="ci-cd-optimizer",
                      tools=tools, context_providers=providers,
                      middleware=[policy_middleware, TracingChatMiddleware(episode_ref, model_name)],
                      default_options=policy.chat_options() or None)
        names = [f.name for f in mcp.functions] + [t.name for t in tools[1:]]
        yield AgentSession(agent, policy, policy_middleware, episode_ref, mcp, root, names)
