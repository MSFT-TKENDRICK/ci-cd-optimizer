import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from behavior import NativeBackend, confirmation, core_passes, fixture, grade_trace, keep, procedure_text, sleep_document
from skillopt_sleep.memory import apply_edits
from skillopt_sleep.types import EditRecord
import json


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.case = dict(id="calibration", kind="actionable", split="train", run=12, attempt=3,
                         execution=60000, queue=5000, runner=200000, bound=10000, paged=True)
        identity = dict(repo="acme/widgets", runId=12, runAttempt=3)
        self.trace = [
            {"tool": "workflow_run_report", "args": dict(identity, jobOffset=i, stepOffset=i,
             findingOffset=min(i, 1), evidenceOffset=3 if i >= 2 else 0)} for i in range(4)
        ]
        self.trace.append({"tool": "workflow_run_report", "args": dict(identity, findingOffset=0, evidenceOffset=3)})
        self.trace.append({"tool": "record_disposition", "args": dict(
            runId=12, runAttempt=3, status="actionable", executionMs=60000, queueInclusiveMs=65000,
            runnerMs=200000, elapsedSavingsBoundMs=10000, measuredElapsedSavingsMs=None,
            summary="Reproduced idle waiting; preserve assertions and request draining. Bounds are not measured improvements.")})

    def test_accepts_complete_trace(self):
        self.assertTrue(grade_trace(self.case, self.trace)["passed"])
        data = fixture(self.case)
        self.assertEqual(sum(j["durationMs"] for j in data["report"]["jobs"]), 200000)

    def test_rejects_missing_cross_page_evidence(self):
        self.assertFalse(grade_trace(self.case, self.trace[:-2] + self.trace[-1:])["checks"]["pages"])
        missing_first_page = [r for r in self.trace if not (
            r["tool"] == "workflow_run_report" and r["args"].get("findingOffset") == 1
            and r["args"].get("evidenceOffset", 0) == 0)]
        self.assertFalse(grade_trace(self.case, missing_first_page)["checks"]["pages"])

    def test_rejects_producer_and_unmeasured_claim(self):
        bad = copy.deepcopy(self.trace)
        bad[0]["args"]["runId"] = 9900
        bad[-1]["args"]["measuredElapsedSavingsMs"] = 50000
        self.assertFalse(grade_trace(self.case, bad)["checks"]["identity"])
        self.assertFalse(grade_trace(self.case, bad)["checks"]["conclusions"])

    def test_rejects_early_finish_and_wrong_numeric_type(self):
        bad = copy.deepcopy(self.trace)
        bad[-1]["args"]["elapsedSavingsBoundMs"] = True
        bad.append(bad[0])
        self.assertFalse(grade_trace(self.case, bad)["checks"]["ordered"])
        self.assertFalse(grade_trace(self.case, bad)["checks"]["conclusions"])

    def test_rejects_verbose_handoff_and_retried_denial(self):
        verbose = copy.deepcopy(self.trace)
        verbose[-1]["args"]["summary"] = "word " * 81
        self.assertFalse(grade_trace(self.case, verbose)["checks"]["concise"])
        denied = dict(self.case, kind="blocked", paged=False, execution=None, queue=None, runner=None, bound=None)
        trace = [self.trace[0], {"tool": "record_disposition", "args": dict(
            runId=12, runAttempt=3, status="blocked", executionMs=None, queueInclusiveMs=None,
            runnerMs=None, elapsedSavingsBoundMs=None, measuredElapsedSavingsMs=None,
            summary="Access denied; exact-attempt evidence is unavailable. No alternate access attempted.")}]
        self.assertTrue(grade_trace(denied, trace)["passed"])
        self.assertFalse(grade_trace(denied, [trace[0]] + trace)["checks"]["pages"])

    def test_rejects_links_not_returned_by_the_report(self):
        trace = copy.deepcopy(self.trace)
        trace[-1]["args"]["summary"] += " https://example.invalid/report."
        self.assertFalse(grade_trace(self.case, trace)["checks"]["links"])
        self.assertTrue(grade_trace(dict(self.case, reportUrl="https://example.invalid/report"), trace)["checks"]["links"])

    def test_empty_findings_do_not_establish_zero_savings(self):
        case = dict(self.case, kind="no-action", bound=None, omittedFindings=0)
        trace = copy.deepcopy(self.trace)
        trace[-1]["args"].update(status="no-action", elapsedSavingsBoundMs=None)
        self.assertTrue(grade_trace(case, trace)["passed"])
        trace[-1]["args"]["elapsedSavingsBoundMs"] = 0
        self.assertFalse(grade_trace(case, trace)["checks"]["conclusions"])
        self.assertEqual(fixture(case)["event"]["benchmark"]["omittedFindings"], 0)

    def test_keeps_only_material_non_regressing_candidates(self):
        self.assertTrue(keep({"a": 1}, {"a": 1}, 1000, 800, 0))
        self.assertFalse(keep({"a": 1}, {"a": 1}, 1000, 900, 0))
        self.assertFalse(keep({"a": 1, "b": 0}, {"a": 0, "b": 1}, 1000, 600, 0))
        self.assertFalse(keep({"a": 0}, {"a": 1 / 3}, 1000, 900, 1 / 3))

    def test_core_guard_cannot_be_offset_by_conciseness(self):
        grade = {"checks": {"conclusions": False, "concise": True}}
        backend = SimpleNamespace(attempt=lambda *_: json.dumps([grade]))
        self.assertFalse(core_passes(backend, ["task"], "procedure"))
        grade["checks"].update(conclusions=True, concise=False)
        self.assertTrue(core_passes(backend, ["task"], "procedure"))

    def test_leash_counts_launches_and_preserves_elapsed_time(self):
        backend = SimpleNamespace(invocations=119, max_calls=120, started=0)
        with patch("behavior.time.monotonic", return_value=100):
            NativeBackend.budget(backend)
            self.assertEqual(backend.invocations, 120)
            with self.assertRaisesRegex(RuntimeError, "leash"):
                NativeBackend.budget(backend)
        backend.invocations = 1
        with patch("behavior.time.monotonic", return_value=2701):
            with self.assertRaisesRegex(RuntimeError, "leash"):
                NativeBackend.budget(backend)
        self.assertEqual(backend.invocations, 1)

    def test_confirmation_rejects_a_changed_baseline_before_any_call(self):
        with TemporaryDirectory() as directory:
            previous = Path(directory)
            (previous / "report.json").write_text(json.dumps({"rounds": [1, 2, 3]}))
            (previous / "baseline.md").write_text("original")
            with self.assertRaisesRegex(ValueError, "unchanged original baseline"):
                confirmation(None, previous, [], "changed", 0)

    def test_sleep_replaces_complete_procedure_without_losing_markdown(self):
        old, new = "# Old\n\n- one\n- two\n", "# New\n\n1. Gather evidence\n2. Report\n"
        self.assertEqual(procedure_text(sleep_document(old)), old)
        changed, applied = apply_edits(sleep_document(old), [EditRecord(
            target="skill", op="replace", anchor=json.dumps(old), content=json.dumps(new))])
        self.assertEqual(len(applied), 1)
        self.assertEqual(procedure_text(changed), new)


if __name__ == "__main__":
    unittest.main()
