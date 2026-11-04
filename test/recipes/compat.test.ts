import { describe, expect, it } from "vitest";
import { classifyIssueOutcome, classifyOutcome, compatibility, wilsonLowerBound } from "../../src/recipes/compat.js";

describe("wilsonLowerBound", () => {
  it("is conservative for small samples", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(3, 3)).toBeCloseTo(0.4385, 3);
    expect(wilsonLowerBound(30, 30)).toBeCloseTo(0.8865, 3);
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5);
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });

  it("grows with evidence at the same rate", () => {
    expect(wilsonLowerBound(90, 100)).toBeGreaterThan(wilsonLowerBound(9, 10));
  });
});

describe("compatibility", () => {
  it("describes missing, insufficient, and sufficient data", () => {
    expect(compatibility({ passed: 0, failed: 0 })).toMatchObject({ total: 0, sufficient: false, display: "No data yet" });
    expect(compatibility({ passed: 2, failed: 1 }).display).toBe("Not enough data (2/3 repositories passed CI)");
    const enough = compatibility({ passed: 9, failed: 1 });
    expect(enough).toMatchObject({ total: 10, rate: 0.9, sufficient: true });
    expect(enough.display).toMatch(/^90% \(9\/10 repositories passed CI; 95% lower bound \d+%\)$/);
  });

  it("honors a custom sample minimum", () => {
    expect(compatibility({ passed: 2, failed: 0 }, 2).sufficient).toBe(true);
  });
});

describe("classifyOutcome", () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });

  it("counts merged pull requests as passed regardless of checks", () => {
    expect(classifyOutcome([run("completed", "failure")], { merged: true })).toBe("passed");
  });

  it("fails on any failing conclusion", () => {
    for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure"]) {
      expect(classifyOutcome([run("completed", "success"), run("completed", conclusion)], { merged: false })).toBe("failed");
    }
  });

  it("waits for running checks and reports missing CI as unknown", () => {
    expect(classifyOutcome([run("completed", "success"), run("in_progress", null)], { merged: false })).toBe("pending");
    expect(classifyOutcome([run("queued", null)], { merged: false })).toBe("pending");
    expect(classifyOutcome([], { merged: false })).toBe("unknown");
  });

  it("passes when every check succeeded, was skipped, or was neutral", () => {
    expect(classifyOutcome([run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")], { merged: false })).toBe("passed");
  });
});

describe("classifyIssueOutcome", () => {
  it("maps issue resolution to outcomes", () => {
    expect(classifyIssueOutcome({ state: "open" })).toBe("pending");
    expect(classifyIssueOutcome({ state: "closed", stateReason: "completed" })).toBe("passed");
    expect(classifyIssueOutcome({ state: "closed", stateReason: "not_planned" })).toBe("failed");
    expect(classifyIssueOutcome({ state: "closed", stateReason: null })).toBe("passed");
  });
});
