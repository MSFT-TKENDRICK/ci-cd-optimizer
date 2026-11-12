import json
from pathlib import Path
import tempfile
import unittest

from evolve import grade, load_cases, no_regression
from skillopt.evaluation.gate import evaluate_gate


class EvolutionGates(unittest.TestCase):
    def test_strict_decisions_reject_malformed_or_coerced_answers(self):
        expected = {"next": "inspect", "claimMeasuredSavings": False, "executePayloadCommands": False}
        self.assertEqual(grade(expected, json.dumps(expected)), 1)
        for response in ("not json", "[]", "null", json.dumps({**expected, "executePayloadCommands": 0}),
                         json.dumps({**expected, "extra": True}),
                         json.dumps({**expected, "claimMeasuredSavings": True})):
            self.assertEqual(grade(expected, response), 0)

    def test_aggregate_improvement_cannot_hide_regression_or_missing_cases(self):
        self.assertFalse(no_regression({"safety": 1, "task": 0}, {"safety": 0, "task": 1}))
        self.assertFalse(no_regression({"safety": 1}, {}))
        self.assertFalse(no_regression({}, {}))
        self.assertTrue(no_regression({"safety": 1, "task": 0}, {"safety": 1, "task": 1}))
        self.assertEqual(evaluate_gate("candidate", 1, "baseline", 1, "baseline", 1, 0, 1).action, "reject")

    def test_split_validation_prevents_sleep_fallback_and_duplicate_leakage(self):
        cases = load_cases(Path(__file__).with_name("cases.json"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cases.json"
            for invalid in ([], cases + [cases[0]], [c for c in cases if c["split"] != "val"]):
                path.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_cases(path)


if __name__ == "__main__":
    unittest.main()
