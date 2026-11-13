"""Hermetic native-MCP behavioral evaluation and bounded SkillOpt/Sleep rounds."""
import argparse
from dataclasses import asdict
from datetime import datetime
from hashlib import sha256
from importlib.metadata import version
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from evolve import ROOT, PROCEDURE, CopilotBackend
from skillopt.evaluation.gate import evaluate_gate
from skillopt_sleep.consolidate import consolidate
from skillopt_sleep.memory import LEARNED_START, current_learned_lines, set_learned
from skillopt_sleep.types import EditRecord, TaskRecord

from behavior_grading import fixture, grade_trace


def sleep_document(procedure):
    # Sleep replaces only its protected region. Encode the entire procedure as one
    # learned item so its line-oriented editor preserves Markdown without patches.
    return set_learned("", [json.dumps(procedure)])


def procedure_text(document):
    if not document.startswith(LEARNED_START):
        return document
    lines = current_learned_lines(document)
    if len(lines) != 1:
        raise ValueError("Expected exactly one protected procedure")
    procedure = json.loads(lines[0])
    if not isinstance(procedure, str):
        raise ValueError("Protected procedure must be text")
    return procedure


class NativeBackend(CopilotBackend):
    name = "copilot-synthetic-mcp"
    def __init__(self, work, output, cases, repeats=3):
        executable = shutil.which("copilot")
        if not executable or (os.name == "nt" and not executable.lower().endswith(".exe")):
            raise RuntimeError("Native Copilot executable is required")
        super().__init__(executable, work, "", output / "unused.json")
        self.output, self.cases, self.repeats = output, cases, repeats
        self.cache, self.records = {}, []
        self.invocations, self.started = 0, time.monotonic()
        self.max_calls = 120
        self.rejects = []

    def budget(self):
        if self.invocations >= self.max_calls or time.monotonic() - self.started > 45 * 60:
            raise RuntimeError("Finite loop leash reached; convergence is unproven")
        self.invocations += 1

    def call(self, prompt):
        self.budget()
        return super().call(prompt)

    def run_one(self, case, skill, label):
        self.budget()
        target = self.output / f"trial-{self.invocations:03d}"
        target.mkdir()
        data = fixture(case)
        input_path, trace_path = target / "fixture.json", target / "trace.jsonl"
        input_path.write_text(json.dumps(data), encoding="utf-8")
        procedure_path = target / "procedure.md"
        procedure_path.write_text(skill, encoding="utf-8")
        prompt = subprocess.check_output([
            "node", "--input-type=module", "-e",
            "import {readFileSync} from 'node:fs'; import {renderFeedbackPrompt} from './scripts/feedback-harness.mjs';"
            "const [f,s]=process.argv.slice(1);process.stdout.write(renderFeedbackPrompt(JSON.parse(readFileSync(f,'utf8')).event,readFileSync(s,'utf8')));",
            str(input_path), str(procedure_path),
        ], cwd=ROOT, text=True, encoding="utf-8")
        prompt += "\nOffline fixture: use only the provided read-only report tool, then record_disposition for your handoff. No repository changes or external calls. Finish after recording."
        config = {"mcpServers": {"ci_fixture": {"type": "stdio", "command": shutil.which("node"),
                    "args": [str(Path(__file__).with_name("fixture-server.mjs")), str(input_path), str(trace_path)],
                    "tools": ["*"]}}}
        config_path = target / "mcp.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        env = dict(os.environ)
        env.pop("COPILOT_ALLOW_ALL", None)
        env["COPILOT_HOME"] = str(self.work / f"home-{self.invocations}")
        result = subprocess.run([
            self.executable, "--additional-mcp-config", "@" + str(config_path),
            "--available-tools", "ci_fixture-workflow_run_report", "ci_fixture-record_disposition",
            "--allow-tool", "ci_fixture", "--disable-builtin-mcps", "--no-custom-instructions",
            "--no-ask-user", "--no-auto-update", "--silent",
            "--usage-output-file", str(target / "usage.json"), "-p", prompt,
        ], cwd=self.work, env=env, capture_output=True, text=True, encoding="utf-8", timeout=150, check=True)
        (target / "response.txt").write_text(result.stdout, encoding="utf-8")
        if not trace_path.exists():
            raise RuntimeError(f"No native MCP trace: {target}; stdout={result.stdout[:300]}, stderr={result.stderr[:300]}")
        trace = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()]
        grade = grade_trace(case, trace)
        grade["procedureBytes"] = len(skill.encode())
        self.records.append({"case": case["id"], "split": case["split"], "label": label,
                             "skillHash": sha256(skill.encode()).hexdigest(), "grade": grade,
                             "trace": str(trace_path.relative_to(self.output))})
        (self.output / "trials.json").write_text(json.dumps(self.records, indent=2), encoding="utf-8")
        print(f'{label} {case["id"]} {grade["checks"]}', flush=True)
        return grade

    def attempt(self, task, skill, memory, sample_id=0):
        skill = procedure_text(skill)
        key = (task.id, sha256(skill.encode()).hexdigest())
        if key not in self.cache:
            try:
                self.cache[key] = [self.run_one(self.cases[task.id], skill, "selection") for _ in range(self.repeats)]
            except (subprocess.SubprocessError, OSError, RuntimeError) as error:
                self.errors.append(str(error))
                raise
        return json.dumps(self.cache[key])

    def judge(self, task, response):
        grades = json.loads(response)
        hard = sum(g["passed"] for g in grades) / len(grades)
        # Size is a secondary objective; strict per-case non-regression is enforced outside Sleep.
        skill_bytes = grades[0]["procedureBytes"]
        utility = hard - 0.05 * min(skill_bytes / 8192, 1)
        return hard, utility, "Native MCP trace + numeric handoff; bounded prompt-size penalty"

    def reflect(self, failures, successes, skill, memory, **kwargs):
        skill = procedure_text(skill)
        if self.errors:
            raise RuntimeError("Incomplete native evaluation")
        evidence = [{"case": t.intent, "grades": json.loads(r.response)} for t, r in failures]
        proposal = json.loads(self.call(
            "Evolve only this trusted procedure for a CI benchmark broadcast. The immutable envelope "
            "already enforces untrusted JSON, exact-attempt pagination, separate metrics, overlapping bounds, "
            "coverage/security/formal/parity, scoped stopping, and no expanded authority. Do not repeat that "
            "envelope. Improve operational specificity and concise handoff. Preserve this exact opening: "
            "'Load `analyze-ci-run`, then `optimize-ci-pipeline`'. Never include scenario IDs or numeric answers. "
            "The handoff must be at most 80 words. Link ONLY URLs actually supplied by tools; otherwise "
            "cite the repository/run/attempt in plain text, never construct a URL. An empty findings "
            "list supplies no savings estimate; do not turn unknown bounds into zero. "
            "Retain the offline-only training/adoption boundary. Prefer <=1100 characters for the whole "
            "procedure: the immutable envelope already contains the mandatory evidence and safety rules. "
            "Return JSON with keys procedure (complete Markdown, <=1800 characters) and rationale. "
            "Use TRAIN failures only; never change graders. Prior rejected proposals must not be repeated.\n"
            + json.dumps({"procedure": skill, "trainFailures": evidence, "rejects": getattr(self, "rejects", [])})
        ))
        candidate = proposal["procedure"]
        if not isinstance(candidate, str) or not candidate.strip() or len(candidate) > 1800:
            raise ValueError("Invalid bounded skill proposal")
        self.proposed = candidate.strip() + "\n"
        return [EditRecord(target="skill", op="replace", anchor=json.dumps(skill),
                           content=json.dumps(self.proposed), rationale=proposal["rationale"])]


def scores(backend, tasks, skill):
    return {t.id: backend.judge(t, backend.attempt(t, skill, ""))[0] for t in tasks}


def keep(before, after, before_bytes, after_bytes, noise):
    no_regression = before.keys() == after.keys() and bool(before) and all(after[k] >= before[k] for k in before)
    delta = (sum(after.values()) - sum(before.values())) / len(before) if before else 0
    return no_regression and (delta > noise or (delta == 0 and after_bytes <= before_bytes * 0.85))


def core_passes(backend, tasks, skill):
    return all(all(value for name, value in grade["checks"].items() if name != "concise")
               for task in tasks for grade in json.loads(backend.attempt(task, skill, "")))


def confirmation(backend, previous, tasks, skill, fixed_bytes):
    """One final candidate after a documented instrument repair; no old holdout reuse."""
    prior = json.loads((previous / "report.json").read_text(encoding="utf-8"))
    if len(prior["rounds"]) != 3:
        raise ValueError("Confirmation is limited to the remaining fourth proposal")
    if skill != (previous / "baseline.md").read_text(encoding="utf-8"):
        raise ValueError("Confirmation requires the unchanged original baseline procedure")
    backend.invocations = prior["invocations"]
    first_usage = json.loads((previous / "trial-001" / "usage.json").read_text(encoding="utf-8"))
    elapsed = time.time() - datetime.fromisoformat(first_usage["sessionStartTime"].replace("Z", "+00:00")).timestamp()
    backend.started = time.monotonic() - elapsed
    prior_trials = json.loads((previous / "trials.json").read_text(encoding="utf-8"))
    aa = {}
    for trial in prior_trials:
        if trial["split"] == "test" or trial["label"] not in ("selection", "A/A"):
            continue
        trace_path = previous / trial["trace"]
        case = backend.cases[trial["case"]]
        if json.loads(trace_path.with_name("fixture.json").read_text(encoding="utf-8")) != fixture(case):
            raise ValueError("Cannot reuse trials after changing their actual fixture")
        trace = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()]
        grade = grade_trace(case, trace)
        grade["procedureBytes"] = trial["grade"]["procedureBytes"]
        if trial["label"] == "A/A":
            aa.setdefault(case["id"], []).append(grade)
        else:
            backend.cache.setdefault((case["id"], trial["skillHash"]), []).append(grade)
    if any(len(grades) != 3 for grades in backend.cache.values()):
        raise ValueError("Cached control requires exactly three independent trials")
    validation = [t for t in tasks if t.split == "val"]
    before = scores(backend, validation, skill)
    if set(aa) != set(before) or any(len(grades) != 3 for grades in aa.values()):
        raise ValueError("A/A control requires the same cases and three independent trials")
    aa_scores = {key: sum(g["passed"] for g in grades) / len(grades) for key, grades in aa.items()}
    noise = abs(sum(before.values()) - sum(aa_scores.values())) / len(before)
    backend.proposed = skill
    result = consolidate(backend, [t for t in tasks if t.split != "test"], sleep_document(skill), "",
                         edit_budget=1, gate_metric="soft", gate_mode="on", rollouts_k=1,
                         evolve_skill=True, evolve_memory=False, night=4)
    if backend.errors:
        raise RuntimeError("Infrastructure failure; no candidate is eligible")
    candidate = backend.proposed
    after = scores(backend, validation, candidate)
    gate = evaluate_gate(candidate, result.candidate_score, skill, result.baseline_score,
                         skill, result.baseline_score, 3, 4)
    accepted = result.accepted and gate.action != "reject" and core_passes(backend, validation, candidate) and keep(
        before, after, fixed_bytes + len(skill.encode()), fixed_bytes + len(candidate.encode()), noise)
    test = [t for t in tasks if t.split == "test"]
    control, treatment = scores(backend, test, skill), scores(backend, test, candidate)
    eligible = accepted and all(treatment[k] >= control[k] for k in control) and all(v == 1 for v in treatment.values())
    report = {
        "version": 2, "priorRun": str(previous.relative_to(ROOT)), "priorResult": "rejected on final holdout",
        "repair": "No finding means unknown saving bound, not zero; remove contradictory omission from clean fixture; reject unprovided URLs.",
        "A/A": [before, aa_scores], "noise": noise, "before": before, "after": after,
        "bytesBefore": fixed_bytes + len(skill.encode()), "bytesAfter": fixed_bytes + len(candidate.encode()),
        "sleepAccepted": result.accepted, "skilloptGate": asdict(gate),
        "holdoutBefore": control, "holdoutAfter": treatment, "eligibleForReview": eligible,
        "totalCliInvocations": backend.invocations, "newCliInvocations": backend.invocations - prior["invocations"],
        "candidateHash": sha256(candidate.encode()).hexdigest(),
        "stop": "four-proposal leash; corrected-instrument convergence not established",
        "cachedReplays": "Original train/validation traces independently regraded; no extra samples claimed.",
        "adopted": False,
    }
    (backend.output / "candidate.md").write_text(candidate, encoding="utf-8")
    (backend.output / "selected.md").write_text(candidate if eligible else skill, encoding="utf-8")
    (backend.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--confirm-run", help="Prior three-proposal run, below .agent-artifacts; consumes remaining leash")
    args = parser.parse_args()
    if version("skillopt") != "0.2.0":
        raise RuntimeError("Use audited skillopt==0.2.0")
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to((ROOT / ".agent-artifacts").resolve()):
        raise ValueError("Output must be inside .agent-artifacts")
    output.mkdir(parents=True, exist_ok=False)
    cases = json.loads(Path(__file__).with_name("behavior-cases.json").read_text(encoding="utf-8"))
    previous = None
    if args.confirm_run:
        previous = (ROOT / args.confirm_run).resolve()
        if not previous.is_relative_to((ROOT / ".agent-artifacts").resolve()):
            raise ValueError("Prior run must be under .agent-artifacts")
        cases = [c for c in cases if c["split"] != "test"] + json.loads(Path(__file__).with_name("confirmation-cases.json").read_text(encoding="utf-8"))
    if {c["split"] for c in cases} != {"train", "val", "test"} or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("Nonempty disjoint train/val/test splits are required")
    skill = PROCEDURE.read_text(encoding="utf-8")
    contract = subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import {feedbackInstructions} from './scripts/feedback-harness.mjs';process.stdout.write(feedbackInstructions);",
    ], cwd=ROOT, text=True, encoding="utf-8")
    fixed_bytes = len(contract.encode()) + len(("\nFeedback skill revision: sha256:" + "0" * 64 + "\n\nBenchmark evidence JSON:\n").encode())
    card = {
        "version": 2, "baselineRef": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "outcome": "Complete exact-attempt evidence gathering and concise, accurate handoff",
        "instrument": "Native Copilot with only synthetic read-only MCP tools; independent trace and numeric checks",
        "metric": "Full-case pass rate (identity, every cursor/evidence combination, numeric disposition, <=80-word handoff, final disposition ordering, supplied URLs only)",
        "keep": "No per-case regression; pass-rate gain strictly above A/A delta OR >=15% instruction-byte reduction at equal behavior",
        "guards": "Immutable contract/delivery/permissions fixed; all non-style validation checks and every selected holdout trial pass; no invented URLs or real changes",
        "repeats": 3, "aaBatches": 2, "holdout": "Test split withheld from proposer and selection",
        "leash": {"rounds": 4, "cliInvocationsIncludingProposals": 120, "minutes": 45},
        "stop": "Two successive non-qualifying rounds; leash exhaustion is inconclusive, not logarithmic convergence",
        "autonomy": "L2 review-only, no live adoption/merge/deployment",
        "softScore": "hard pass rate minus 0.05 * procedure UTF-8 bytes / 8192; outer keep bar controls acceptance",
        "byteMetric": "UTF-8 contract + procedure + revision/delimiter; excludes unchanged event data",
        "caseHash": sha256(json.dumps(cases, sort_keys=True).encode()).hexdigest(),
        "instrumentHash": sha256(Path(__file__).read_bytes() + Path(__file__).with_name("fixture-server.mjs").read_bytes()).hexdigest(),
    }
    (output / "loop-card.json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    (output / "cases.json").write_text(json.dumps(cases, indent=2), encoding="utf-8")
    shutil.copyfile(__file__, output / "instrument.py")
    shutil.copyfile(Path(__file__).with_name("fixture-server.mjs"), output / "fixture-server.mjs")
    with tempfile.TemporaryDirectory(prefix="ci-behavior-") as directory:
        backend = NativeBackend(Path(directory), output, {c["id"]: c for c in cases})
        if args.smoke:
            print(json.dumps(backend.run_one(cases[0], skill, "instrument-smoke"), indent=2))
            return
        tasks = [TaskRecord(id=c["id"], intent=json.dumps(c), project="synthetic-behavior", split=c["split"], origin="synthetic") for c in cases]
        if previous:
            confirmation(backend, previous, tasks, skill, fixed_bytes)
            return
        validation = [t for t in tasks if t.split == "val"]
        aa1 = scores(backend, validation, skill)
        aa2 = {t.id: sum(backend.run_one(backend.cases[t.id], skill, "A/A")["passed"] for _ in range(3)) / 3 for t in validation}
        noise = abs(sum(aa1.values()) - sum(aa2.values())) / len(aa1)
        report = {"baselineRef": card["baselineRef"], "skillopt": version("skillopt"), "scope": "Native synthetic MCP report triage, not live CI optimization",
                  "caseHash": sha256(Path(__file__).with_name("behavior-cases.json").read_bytes()).hexdigest(),
                  "A/A": [aa1, aa2], "noise": noise, "rounds": [], "adopted": False}
        (output / "baseline.md").write_text(skill, encoding="utf-8")
        selected = skill
        rejected = 0
        for round_id in range(1, 5):
            before = scores(backend, validation, selected)
            backend.proposed = selected
            result = consolidate(backend, [t for t in tasks if t.split != "test"], sleep_document(selected), "",
                                 edit_budget=1, gate_metric="soft", gate_mode="on", rollouts_k=1,
                                 evolve_skill=True, evolve_memory=False, night=round_id)
            if backend.errors:
                raise RuntimeError("Infrastructure failure; no candidate is eligible")
            candidate = backend.proposed
            after = scores(backend, validation, candidate)
            gate = evaluate_gate(candidate, result.candidate_score, selected, result.baseline_score,
                                 selected, result.baseline_score, round_id - 1, round_id)
            before_bytes, after_bytes = fixed_bytes + len(selected.encode()), fixed_bytes + len(candidate.encode())
            accepted = result.accepted and gate.action != "reject" and core_passes(backend, validation, candidate) and keep(before, after, before_bytes, after_bytes, noise)
            entry = {"round": round_id, "before": before, "after": after, "bytesBefore": before_bytes,
                     "bytesAfter": after_bytes, "accepted": accepted,
                     "sleepAccepted": result.accepted, "skilloptGate": asdict(gate),
                     "reason": "strict gain above A/A or >=15% smaller at equal behavior; no per-case regression"}
            report["rounds"].append(entry)
            (output / f"candidate-{round_id}.md").write_text(candidate, encoding="utf-8")
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(entry), flush=True)
            if accepted:
                selected, rejected = candidate, 0
            else:
                backend.rejects.append({"procedure": candidate, "reason": entry["reason"]})
                rejected += 1
            if rejected >= 2:
                break
        test = [t for t in tasks if t.split == "test"]
        control, treatment = scores(backend, test, skill), scores(backend, test, selected)
        eligible = selected != skill and all(treatment[k] >= control[k] for k in control) and all(v == 1 for v in treatment.values())
        report.update({"holdoutBefore": control, "holdoutAfter": treatment, "eligibleForReview": eligible,
                       "invocations": backend.invocations, "stop": "two successive non-qualifying rounds" if rejected >= 2 else "round leash; convergence unproven",
                       "cachedReplays": "Identical task/procedure replay reuses its three recorded trials, never counted as new samples."})
        (output / "selected.md").write_text(selected if eligible else skill, encoding="utf-8")
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
