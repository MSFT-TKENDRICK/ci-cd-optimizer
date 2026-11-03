import { describe, expect, it } from "vitest";
import { createAnnotations, createSummary } from "../src/report.js";

const finding = {
  ruleId: "dependency-cache",
  title: "Cache downloaded dependencies",
  severity: "high" as const,
  confidence: "high" as const,
  effort: "small" as const,
  category: "caching" as const,
  estimatedImpact: "Saves time",
  explanation: "No cache was found.",
  recommendation: "Configure a cache.",
  evidence: { path: ".github/workflows/ci.yml", line: 8 },
};

describe("report", () => {
  it("renders a concise markdown summary", () => {
    expect(createSummary([finding], false)).toContain("1 CI/CD optimization finding");
  });

  it("creates check annotations", () => {
    expect(createAnnotations([finding])[0]).toMatchObject({
      path: ".github/workflows/ci.yml",
      start_line: 8,
      annotation_level: "warning",
    });
  });
});
