import rule from "../../../../src/lint/rules/triggers/serialized-matrix.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const job = (strategy: string[], extra: string[] = []) =>
  yml("on: pull_request", "jobs:", "  test:", "    runs-on: x", ...extra, "    strategy:", ...strategy, "    steps:", "      - run: make test");

ruleTester(rule, {
  valid: [
    { name: "no max-parallel", files: job(["      matrix:", "        node: [18, 20, 22]"]) },
    { name: "max-parallel close to size", files: job(["      max-parallel: 2", "      matrix:", "        node: [18, 20, 22]"]) },
    { name: "max-parallel equals size", files: job(["      max-parallel: 3", "      matrix:", "        node: [18, 20, 22]"]) },
    {
      name: "job has a concurrency group",
      files: job(["      max-parallel: 1", "      matrix:", "        node: [18, 20, 22]"], ["    concurrency: shared-db"]),
    },
    { name: "expression matrix", files: job(["      max-parallel: 1", "      matrix: ${{ fromJSON(needs.plan.outputs.m) }}"]) },
    { name: "expression max-parallel", files: job(["      max-parallel: ${{ inputs.p }}", "      matrix:", "        node: [18, 20, 22]"]) },
    {
      name: "deploy workflow",
      files: { ".github/workflows/deploy.yml": job(["      max-parallel: 1", "      matrix:", "        region: [a, b, c]"]) },
    },
  ],
  invalid: [
    {
      files: job(["      max-parallel: 1", "      matrix:", "        node: [18, 20, 22]"]),
      errors: [{ line: 6, messageIncludes: "3 matrix legs at most 1" }],
    },
    {
      name: "low ratio across axes",
      files: job(["      max-parallel: 2", "      matrix:", "        os: [a, b, c, d]", "        node: [18, 20]"]),
      errors: [{ messageIncludes: "8 matrix legs at most 2" }],
    },
  ],
});
