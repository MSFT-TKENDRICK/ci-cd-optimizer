import rule from "../../../../src/lint/rules/triggers/shard-fail-fast.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const job = (on: string, failFast: string, key = "shard") =>
  yml(on, "jobs:", "  test:", "    runs-on: x", "    strategy:", `      fail-fast: ${failFast}`, "      matrix:", `        ${key}: [1, 2, 3, 4]`, "    steps:", "      - run: make test");

ruleTester(rule, {
  valid: [
    { name: "fail-fast true", files: job("on: pull_request", "true") },
    { name: "push only", files: job("on: push", "false") },
    { name: "not a shard matrix", files: job("on: pull_request", "false", "node") },
    { name: "conditional fail-fast", files: job("on: pull_request", "${{ github.event_name != 'pull_request' }}") },
    {
      name: "fail-fast unset",
      files: yml("on: pull_request", "jobs:", "  test:", "    runs-on: x", "    strategy:", "      matrix:", "        shard: [1, 2]"),
    },
  ],
  invalid: [
    { files: job("on: pull_request", "false"), errors: [{ line: 6, messageIncludes: 'by "shard"' }] },
    { name: "shardIndex key", files: job("on: [pull_request, push]", "false", "shardIndex"), errors: 1 },
    { name: "chunk key", files: job("on: pull_request", "false", "chunk"), errors: 1 },
  ],
});
