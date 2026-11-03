import { describe, expect, it } from "vitest";
import { analyze, shouldFail } from "../src/analyzer.js";
import { defaultConfig } from "../src/config.js";

describe("analyze", () => {
  it("finds missing workflow cache, concurrency, timeout, and immutable install", () => {
    const findings = analyze(
      [
        {
          path: ".github/workflows/ci.yml",
          size: 100,
          content: `name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test
`,
        },
      ],
      defaultConfig,
    );

    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "dependency-cache",
        "immutable-dependency-install",
        "workflow-concurrency",
        "workflow-timeout",
      ]),
    );
  });

  it("finds invalidated Docker dependency layers", () => {
    const findings = analyze(
      [
        {
          path: "Dockerfile",
          size: 60,
          content: "FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD [\"node\", \"server.js\"]\n",
        },
      ],
      defaultConfig,
    );

    expect(findings.some((finding) => finding.ruleId === "docker-dependency-layer")).toBe(true);
  });

  it("respects disabled rules and ignored paths", () => {
    const findings = analyze(
      [
        {
          path: "vendor/Dockerfile",
          size: 60,
          content: "FROM node:22\nCOPY . .\nRUN npm ci\n",
        },
      ],
      {
        ...defaultConfig,
        disabledRules: ["workflow-timeout"],
      },
    );
    expect(findings).toEqual([]);
  });
});

describe("shouldFail", () => {
  const finding = {
    ruleId: "test",
    title: "Test",
    severity: "high" as const,
    confidence: "high" as const,
    effort: "small" as const,
    category: "caching" as const,
    estimatedImpact: "Fast",
    explanation: "Explanation",
    recommendation: "Recommendation",
    evidence: { path: "file" },
  };

  it("keeps advisory mode neutral by default", () => {
    expect(shouldFail([finding], "never")).toBe(false);
  });

  it("can enforce a configured threshold", () => {
    expect(shouldFail([finding], "high")).toBe(true);
  });
});
