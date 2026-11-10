import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/workflow/matrix-explosion.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...matrixLines: string[]): string =>
  yml(
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    ...matrixLines,
    "    steps:",
    "      - run: npm test",
  );

const OS_NODE_DB = [
  "        os: [ubuntu-latest, windows-latest, macos-latest]",
  "        node: [18, 20, 22, 24]",
  "        db: [postgres, mysql]",
];

const range = (count: number): string => `[${Array.from({ length: count }, (_, index) => index + 1).join(", ")}]`;

ruleTester(rule, {
  valid: [
    {
      name: "small matrix (3 x 3)",
      files: job("        os: [ubuntu-latest, windows-latest, macos-latest]", "        node: [20, 22, 24]"),
    },
    {
      name: "trap: whole matrix from an expression is unknown",
      files: job("        ${{ fromJSON(needs.plan.outputs.matrix) }}").replace(
        "      matrix:\n        ${{",
        "      matrix: ${{",
      ),
    },
    {
      name: "trap: one dimension from an expression is unknown",
      files: job(...OS_NODE_DB.slice(0, 2), "        db: ${{ fromJSON(vars.DATABASES) }}", "        shard: [1, 2, 3, 4]"),
    },
    {
      name: "trap: exclude brings 24 combinations down to 16",
      files: job(...OS_NODE_DB, "        exclude:", "          - os: macos-latest"),
    },
    {
      name: "trap: include rows that extend existing combinations add no jobs (4 x 5 = 20)",
      files: job(
        "        os: [ubuntu-latest, windows-latest, macos-latest, ubuntu-24.04-arm]",
        "        node: [18, 20, 22, 24, 25]",
        "        include:",
        "          - os: ubuntu-latest",
        "            coverage: true",
        "          - node: 25",
        "            experimental: true",
      ),
    },
    {
      name: "include-only matrix within budget",
      files: job(
        "        include:",
        "          - { os: ubuntu-latest, node: 24 }",
        "          - { os: windows-latest, node: 24 }",
        "          - { os: macos-latest, node: 24 }",
      ),
    },
    {
      name: "custom maxJobs budget",
      files: job(...OS_NODE_DB),
      options: { maxJobs: 30 },
    },
    {
      name: "trap: 24 test shards are deliberate fan-out, not an explosion",
      files: job(`        shard: ${range(24)}`),
    },
    {
      name: "trap: one leg per package (30 packages) cannot be thinned",
      files: job(`        package: [${Array.from({ length: 30 }, (_, index) => `pkg-${index + 1}`).join(", ")}]`),
    },
    {
      name: "trap: integer dimensions with no version name are not treated as version ranges (5 x 5)",
      files: job(`        a: ${range(5)}`, `        b: ${range(5)}`),
    },
  ],
  invalid: [
    {
      name: "3 OS x 4 versions x 2 databases",
      files: job(...OS_NODE_DB),
      errors: [{ line: 6, messageIncludes: "Matrix of job `test` expands to 24 jobs (os 3 × node 4 × db 2). That is above the configured 20-job budget; actual queueing depends on available runners and account limits." }],
    },
    {
      name: "include rows that add new combinations count as jobs",
      files: job(
        "        os: [ubuntu-latest, windows-latest, macos-latest, ubuntu-24.04-arm]",
        "        node: [18, 20, 22, 24, 25]",
        "        include:",
        "          - os: windows-11-arm",
        "            node: 24",
      ),
      errors: [{ line: 6, messageIncludes: "expands to 21 jobs (os 4 × node 5, 1 include)" }],
    },
    {
      name: "more than 256 jobs is rejected by GitHub",
      files: job(`        a: ${range(17)}`, `        b: ${range(16)}`),
      errors: [{ line: 6, messageIncludes: "expands to 272 jobs (a 17 × b 16). GitHub rejects it" }],
    },
    {
      name: "huge product is reported as a lower bound",
      files: job(...["a", "b", "c", "d", "e", "f"].map((name) => `        ${name}: ${range(7)}`)),
      errors: [{ line: 6, messageIncludes: "expands to at least 117649 jobs" }],
    },
    {
      name: "custom maxJobs budget is exceeded",
      files: job("        os: [ubuntu-latest, windows-latest, macos-latest]", "        node: [20, 22, 24]"),
      options: { maxJobs: 6 },
      errors: [{ line: 6, messageIncludes: "Matrix of job `test` expands to 9 jobs (os 3 × node 3). That is above the configured 6-job budget; actual queueing depends on available runners and account limits." }],
    },
  ],
});

describe("workflow/matrix-explosion suggestion", () => {
  it("requires a coverage decision and preserves every database on every runner", () => {
    const [diagnostic] = runRule(rule, { files: job(...OS_NODE_DB) });
    expect(diagnostic?.suggestion).toContain(
      [
        "strategy:",
        "  matrix:",
        "    os: [ubuntu-latest]",
        "    node: [18, 24]",
        "    db: [postgres, mysql]",
        "    include:",
        "      - { os: windows-latest, node: 24, db: postgres }",
        "      - { os: windows-latest, node: 24, db: mysql }",
        "      - { os: macos-latest, node: 24, db: postgres }",
        "      - { os: macos-latest, node: 24, db: mysql }",
      ].join("\n"),
    );
    expect(diagnostic?.suggestion).toContain("(8 jobs)");
    expect(diagnostic?.suggestion).toContain("coverage tradeoff, not an equivalent replacement");
    expect(diagnostic?.fix).toBeUndefined();
  });

  it("keeps quoted version text such as \"3.10\"", () => {
    const [diagnostic] = runRule(rule, {
      files: job(
        "        os: [ubuntu-latest, windows-latest, macos-latest]",
        "        python: [\"3.9\", \"3.10\", \"3.11\", \"3.12\", \"3.13\"]",
        "        django: [4.2, 5.1, 5.2]",
      ),
    });
    expect(diagnostic?.suggestion).toContain("    python: [\"3.9\", \"3.13\"]");
  });

  it("picks the oldest and newest version even when the list is unsorted", () => {
    const [diagnostic] = runRule(rule, {
      files: job("        os: [ubuntu-latest, windows-latest, macos-latest]", "        node: [24, 18, 22, 20]", "        db: [postgres, mysql]"),
    });
    expect(diagnostic?.suggestion).toContain("    node: [18, 24]");
    expect(diagnostic?.suggestion).toContain("      - { os: windows-latest, node: 24, db: mysql }");
  });

  it("keeps every shard, including on each extra runner", () => {
    const [diagnostic] = runRule(rule, {
      files: job("        os: [ubuntu-latest, windows-latest, macos-latest]", "        node: [18, 20, 22]", "        shard: [1, 2, 3, 4]"),
    });
    expect(diagnostic?.message).toContain("expands to 36 jobs");
    expect(diagnostic?.suggestion).toContain("(16 jobs)");
    expect(diagnostic?.suggestion).toContain(
      [
        "    os: [ubuntu-latest]",
        "    node: [18, 22]",
        "    shard: [1, 2, 3, 4]",
        "    include:",
        "      - { os: windows-latest, node: 22, shard: 1 }",
        "      - { os: windows-latest, node: 22, shard: 2 }",
        "      - { os: windows-latest, node: 22, shard: 3 }",
        "      - { os: windows-latest, node: 22, shard: 4 }",
        "      - { os: macos-latest, node: 22, shard: 1 }",
      ].join("\n"),
    );
  });

  it("recognises a shard dimension from how a step uses it", () => {
    const files = job("        node: [18, 20, 22]", `        n: ${range(8)}`).replace(
      "      - run: npm test",
      "      - run: npx jest --shard=${{ matrix.n }}/8",
    );
    const [diagnostic] = runRule(rule, { files });
    expect(diagnostic?.suggestion).toContain("    n: [1, 2, 3, 4, 5, 6, 7, 8]");
    expect(diagnostic?.suggestion).toContain("    node: [18, 22]");
  });

  it("rejects an out-of-range maxJobs option", () => {
    expect(rule.meta.validateOptions?.({ maxJobs: 300 })).toEqual(["maxJobs must be an integer between 1 and 256"]);
  });
});
