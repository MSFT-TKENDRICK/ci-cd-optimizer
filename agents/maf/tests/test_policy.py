import asyncio
import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from agent_framework import MiddlewareFailure, MiddlewareTermination

from cicd_agent.agent import build_chat_agent
from cicd_agent.clients import ScriptedChatClient
from cicd_agent.config import paths
from cicd_agent.policy import FORBIDDEN_TOOLS, Policy, PolicyMiddleware, PolicyViolation
from cicd_agent.tracing import Episode


def test_committed_policy_loads():
    policy = Policy.load(paths().policy)
    assert policy.confine_root
    assert not set(FORBIDDEN_TOOLS) & set(policy.allowed_tools)


@pytest.mark.parametrize("change", [
    {"allowed_tools": ("lint", "run_skill_script")},
    {"allowed_tools": ("shell",)},
    {"on_violation": "ignore"},
    {"max_function_calls": 0},
    {"max_function_calls": 121},
    {"max_iterations": 61},
    {"max_duration_seconds": 2701},
    {"max_tool_result_chars": 999},
    {"max_tool_result_chars": 200_001},
    {"instructions_variant": "../plugin"},
    {"instructions_variant": "Plugin"},
    {"reasoning_effort": "bogus"},
    {"reasoning_effort": ""},
])
def test_validate_rejects_out_of_bounds(change):
    with pytest.raises(ValueError):
        dataclasses.replace(Policy(), **change).validate()


def test_round_trip_preserves_fields_and_extra(tmp_path: Path):
    policy = dataclasses.replace(Policy(), handoff_tool=True, max_function_calls=12, instructions_variant="concise",
                                 reasoning_effort="medium", extra={"note": "kept"})
    path = tmp_path / "policy.json"
    path.write_text(json.dumps({"$schema": "x", **policy.as_json()}), encoding="utf-8")
    loaded = Policy.load(path)
    assert loaded == policy
    assert "$schema" not in loaded.extra


class OptionRecordingClient(ScriptedChatClient):
    def __init__(self, reasoning_tokens: int = 0) -> None:
        super().__init__([("text", "ok")])
        self.options: list[dict] = []
        self.reasoning_tokens = reasoning_tokens

    def _inner_get_response(self, *, messages, stream, options, **kwargs):  # noqa: ANN001 - framework signature
        self.options.append(dict(options or {}))
        return self._with_reasoning(super()._inner_get_response(messages=messages, stream=stream, options=options,
                                                                **kwargs))

    async def _with_reasoning(self, pending):  # noqa: ANN001, ANN202 - awaitable ChatResponse
        response = await pending
        response.usage_details["reasoning_output_token_count"] = self.reasoning_tokens
        return response


@pytest.mark.parametrize("effort", [None, "low"])
def test_reasoning_effort_reaches_every_model_request(effort):
    client = OptionRecordingClient()
    asyncio.run(build_chat_agent(client, policy=dataclasses.replace(Policy(), reasoning_effort=effort)).run("hi"))
    assert [o.get("reasoning_effort") for o in client.options] == [effort]


def test_episode_usage_counts_reasoning_tokens():
    episode = Episode(rollout_id="r", input={})
    asyncio.run(build_chat_agent(OptionRecordingClient(reasoning_tokens=953), policy=Policy()).run("hi", episode))
    assert episode.usage["reasoning_output_token_count"] == 953
    assert episode.usage["requests"] == 1


def test_load_rejects_unsafe_file(tmp_path: Path):
    path = tmp_path / "policy.json"
    path.write_text(json.dumps({"allowedTools": ["run_skill_script"]}), encoding="utf-8")
    with pytest.raises(ValueError):
        Policy.load(path)


def test_allows_never_permits_skill_scripts_and_gates_handoff_tool():
    narrowed = dataclasses.replace(Policy(), allowed_tools=("lint",))
    assert not narrowed.allows("run_skill_script")
    assert not narrowed.allows("collect_run_report")
    assert dataclasses.replace(narrowed, handoff_tool=True).allows("collect_run_report")
    assert not Policy().allows("shell")


def middleware(tmp_path: Path, **change) -> tuple[PolicyMiddleware, list[dict]]:
    events: list[dict] = []
    policy = dataclasses.replace(Policy(), **change)
    return PolicyMiddleware(policy, [tmp_path], events.append, root_tools=("lint",)), events


def test_confine_fills_and_resolves_roots(tmp_path: Path):
    mw, _ = middleware(tmp_path)
    for empty in (None, "", ".", "./"):
        args = {"root": empty}
        mw._confine("lint", args)
        assert Path(args["root"]) == Path(mw.roots[0])
    (tmp_path / "sub").mkdir()
    args = {"root": "sub"}
    mw._confine("lint", args)
    assert Path(args["root"]) == Path(mw.roots[0]) / "sub"
    untouched = {"rule": "x"}
    mw._confine("explain_rule", untouched)
    assert untouched == {"rule": "x"}


def test_confine_blocks_escape(tmp_path: Path):
    mw, events = middleware(tmp_path / "ws")
    (tmp_path / "ws").mkdir()
    with pytest.raises(PolicyViolation):
        mw._confine("lint", {"root": str(tmp_path)})
    with pytest.raises(PolicyViolation):
        mw._confine("lint", {"root": "../"})
    assert [e["type"] for e in events] == ["policy_violation", "policy_violation"]
    abort, _ = middleware(tmp_path / "ws", on_violation="abort")
    with pytest.raises(MiddlewareFailure):
        abort._confine("lint", {"root": str(tmp_path)})


def test_root_tool_without_configured_root_is_blocked():
    mw = PolicyMiddleware(Policy(), [], root_tools=("lint",))
    with pytest.raises(PolicyViolation):
        mw._confine("lint", {})


def test_bound_truncates_strings_and_text_lists(tmp_path: Path):
    mw, _ = middleware(tmp_path, max_tool_result_chars=1000)
    assert mw._bound("short") == "short"
    clipped = mw._bound("x" * 1500)
    assert clipped.startswith("x" * 1000) and clipped.endswith("[truncated 500 chars by harness policy]")
    texts = [SimpleNamespace(text="a" * 600), SimpleNamespace(text="b" * 600)]
    (joined,) = mw._bound(texts)
    assert joined.text.endswith("[truncated 201 chars by harness policy]")


def run_process(mw: PolicyMiddleware, name: str, arguments: dict, result: str = "ok"):
    context = SimpleNamespace(function=SimpleNamespace(name=name), arguments=arguments, result=None)

    async def call_next():
        context.result = result

    asyncio.run(mw.process(context, call_next))
    return context


def test_process_enforces_allowlist_and_budget(tmp_path: Path):
    mw, events = middleware(tmp_path, max_function_calls=2)
    with pytest.raises(PolicyViolation):
        run_process(mw, "run_skill_script", {})
    mw.reset()
    assert run_process(mw, "lint", {}).arguments["root"] == str(mw.roots[0])
    run_process(mw, "list_rules", {})
    with pytest.raises(MiddlewareTermination):
        run_process(mw, "list_rules", {})
    assert events[-1]["type"] == "policy_budget"
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["lint", "list_rules"]
