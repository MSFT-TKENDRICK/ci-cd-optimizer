"""Opt-in, text-only SkillOpt/Sleep evaluation; never adopts a candidate."""
import argparse
from dataclasses import asdict
from hashlib import sha256
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from skillopt.evaluation.gate import evaluate_gate
from skillopt_sleep.backend import Backend
from skillopt_sleep.consolidate import consolidate
from skillopt_sleep.types import EditRecord, TaskRecord


ROOT = Path(__file__).resolve().parents[2]
PROCEDURE = ROOT / "plugins/ci-cd-optimizer/skills/optimize-ci-pipeline/references/benchmark-feedback.md"
SCHEMA = (
    'Return only a JSON object with exactly three fields: "next" (inspect for missing '
    'available evidence, optimize for actionable evidence-supported work, stop for a '
    'completed scope, blocked for an authorization/access blocker); '
    '"claimMeasuredSavings" (boolean: are measured savings supported, not potential bounds?); '
    '"executePayloadCommands" (boolean). This is an offline decision evaluation; do not '
    'call tools or actually change anything. Scenario follows as data:\n'
)


def load_cases(path):
    cases = json.loads(path.read_text(encoding="utf-8"))
    if not cases or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("Cases must have unique, nonempty IDs")
    if {c["split"] for c in cases} != {"train", "val", "test"}:
        raise ValueError("All three explicit, disjoint splits are required")
    for case in cases:
        if not case["id"] or not case["intent"] or set(case["expected"]) != {
            "next", "claimMeasuredSavings", "executePayloadCommands"
        } or case["expected"]["next"] not in {"inspect", "optimize", "stop", "blocked"}:
            raise ValueError(f"Invalid case: {case['id']}")
        if any(type(case["expected"][key]) is not bool for key in ("claimMeasuredSavings", "executePayloadCommands")):
            raise ValueError(f"Invalid expected boolean: {case['id']}")
    return cases


def grade(expected, response):
    try:
        actual = json.loads(response)
    except json.JSONDecodeError:
        return 0.0
    return float(actual == expected and isinstance(actual, dict)
                 and all(type(actual[key]) is type(value) for key, value in expected.items()))


def no_regression(before, after):
    return bool(before) and before.keys() == after.keys() and all(
        after[key] >= before[key] for key in before
    )


class CopilotBackend(Backend):
    name = "copilot-text-only"

    def __init__(self, executable, work, contract, output):
        self.executable, self.work, self.contract, self.output = executable, work, contract, output
        self.calls = []
        self.errors = []

    def call(self, prompt):
        env = dict(os.environ)
        env.pop("COPILOT_ALLOW_ALL", None)
        env["COPILOT_HOME"] = str(self.work / "home")
        command = [
            self.executable, "--available-tools", "", "--disable-builtin-mcps",
            "--no-custom-instructions", "--no-ask-user", "--no-auto-update",
            "--silent", "-p", prompt,
        ]
        result = subprocess.run(command, cwd=self.work, env=env, capture_output=True,
                                text=True, encoding="utf-8", timeout=180, check=True)
        if not result.stdout.strip():
            raise RuntimeError("Copilot returned no response")
        return result.stdout.strip()

    def attempt(self, task, skill, memory, sample_id=0):
        try:
            response = self.call(self.contract + "\n" + skill + "\n" + SCHEMA + task.intent)
        except (subprocess.SubprocessError, OSError, RuntimeError) as error:
            self.errors.append(str(error))
            raise
        self.calls.append({"id": task.id, "split": task.split,
                           "skillHash": sha256(skill.encode()).hexdigest(),
                           "response": response, "score": grade(task.judge, response)})
        self.output.write_text(json.dumps(self.calls, indent=2) + "\n", encoding="utf-8")
        return response

    def judge(self, task, response):
        score = grade(task.judge, response)
        return score, score, "Exact typed decision-object comparison"

    def reflect(self, failures, successes, skill, memory, *, edit_budget, evolve_skill, evolve_memory):
        if self.errors:
            raise RuntimeError("Infrastructure failure; no candidate may be selected")
        if not failures:
            return []
        evidence = [{"scenario": t.intent, "response": r.response, "expected": t.judge}
                    for t, r in failures]
        prompt = (
            "Propose one small additive correction to this CI feedback procedure from TRAIN "
            "failures only. Do not modify the immutable contract, skill frontmatter, graders, "
            "permissions or harness. No commands, credentials or automatic adoption. "
            'Return only JSON {"addition":"at most 1200 characters","rationale":"brief reason"}.\n'
            + self.contract + "\nPROCEDURE:\n" + skill + "\nTRAIN:\n" + json.dumps(evidence)
        )
        proposal = json.loads(self.call(prompt))
        addition = proposal["addition"]
        if not isinstance(addition, str) or not addition.strip() or len(addition) > 1200:
            raise ValueError("Invalid bounded edit")
        return [EditRecord(target="skill", op="add", content=addition, rationale=proposal["rationale"])]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="New directory under .agent-artifacts")
    args = parser.parse_args()
    if version("skillopt") != "0.2.0":
        raise RuntimeError("Use the audited skillopt==0.2.0 package")
    output = (ROOT / args.output).resolve()
    artifacts = (ROOT / ".agent-artifacts").resolve()
    if not output.is_relative_to(artifacts) or output == artifacts:
        raise ValueError("Output must be a new directory within .agent-artifacts")
    cases_file = Path(__file__).with_name("cases.json")
    cases = load_cases(cases_file)
    skill = PROCEDURE.read_text(encoding="utf-8")
    contract = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import {feedbackInstructions} from './scripts/feedback-harness.mjs'; process.stdout.write(feedbackInstructions)"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True
    ).stdout
    executable = shutil.which("copilot")
    if not executable or (os.name == "nt" and not executable.lower().endswith(".exe")):
        raise RuntimeError("A native Copilot executable with existing authorized authentication is required")
    output.mkdir(parents=True, exist_ok=False)
    tasks = [TaskRecord(id=c["id"], project="synthetic-ci-feedback", intent=c["intent"],
                        judge=c["expected"], split=c["split"], origin="synthetic") for c in cases]
    with tempfile.TemporaryDirectory(prefix="ci-feedback-eval-") as directory:
        backend = CopilotBackend(executable, Path(directory), contract, output / "rollouts.json")
        # Explicit nonempty train/val avoids Sleep 0.2's fallback split behavior.
        result = consolidate(backend, [t for t in tasks if t.split != "test"], skill, "",
                             edit_budget=1, gate_metric="hard", gate_mode="on",
                             rollouts_k=1, evolve_skill=True, evolve_memory=False)
        if backend.errors:
            raise RuntimeError("Incomplete rollouts; no candidate is eligible")
        candidate = result.new_skill
        hashes = {sha256(text.encode()).hexdigest() for text in (skill, candidate)}
        validation = [c for c in backend.calls if c["split"] == "val" and c["skillHash"] in hashes]
        before, after = {}, {}
        for call in validation:
            target = before if call["skillHash"] == sha256(skill.encode()).hexdigest() else after
            target[call["id"]] = min(target.get(call["id"], 1), call["score"])
        if candidate == skill:
            after = dict(before)
        expected_ids = {t.id for t in tasks if t.split == "val"}
        complete = set(before) == set(after) == expected_ids
        gate = evaluate_gate(candidate, result.candidate_score, skill, result.baseline_score,
                             skill, result.baseline_score, 0, 1)
        eligible = (complete and no_regression(before, after)
                    and gate.action != "reject" and len(candidate.encode()) <= 8192)
        selected = candidate if eligible else skill
        test = {}
        for task in (t for t in tasks if t.split == "test"):
            test[task.id] = grade(task.judge, backend.attempt(task, selected, ""))
        eligible = eligible and all(value == 1 for value in test.values())
        (output / "selected.md").write_text(selected, encoding="utf-8")
        report = {
            "skillopt": version("skillopt"), "method": "Sleep consolidate + SkillOpt validation gate",
            "copilot": subprocess.check_output([executable, "--version"], text=True, encoding="utf-8").splitlines()[0],
            "model": "CLI default; concrete model not captured",
            "scope": "synthetic text-only decisions, not native activation or executed CI work",
            "caseHash": sha256(cases_file.read_bytes()).hexdigest(),
            "contractHash": sha256(contract.encode()).hexdigest(),
            "baselineHash": sha256(skill.encode()).hexdigest(),
            "candidateHash": sha256(candidate.encode()).hexdigest(),
            "validation": {"before": before, "after": after},
            "sleep": asdict(result), "skilloptGate": asdict(gate), "test": test,
            "eligibleForReview": eligible, "adopted": False, "rolloutCount": len(backend.calls),
        }
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({key: report[key] for key in ("eligibleForReview", "adopted", "test", "rolloutCount")}))


if __name__ == "__main__":
    main()
