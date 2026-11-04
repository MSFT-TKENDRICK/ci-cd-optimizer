import { describe, expect, it } from "vitest";
import { DEFAULT_ROLLOUT, parseRolloutTargets, parseWaveSize, planRollout, rolloutOrder, waveSizes, type TargetStatus } from "../../src/recipes/rollout.js";

const repos = Array.from({ length: 20 }, (_, index) => `acme/repo-${String(index).padStart(2, "0")}`);
const statuses = (states: Record<string, TargetStatus["state"]>, all = repos): TargetStatus[] => all.map((repo) => ({ repo, state: states[repo] ?? "untouched" }));

describe("waveSizes", () => {
  it("is cumulative, capped, and always ends with everything", () => {
    expect(waveSizes([1, 3, "25%", "100%"], 20)).toEqual([1, 3, 5, 20]);
    expect(waveSizes([1, 3, "25%", "100%"], 2)).toEqual([1, 2, 2, 2]);
    expect(waveSizes([5, 2], 10)).toEqual([5, 5, 10]);
    expect(waveSizes([], 4)).toEqual([4]);
  });
});

describe("parseWaveSize", () => {
  it("accepts positive integers and percentages", () => {
    expect(parseWaveSize(3)).toBe(3);
    expect(parseWaveSize("25%")).toBe("25%");
    expect(parseWaveSize("12.5%")).toBe("12.5%");
    for (const bad of [0, -1, 1.5, "0%", "150%", "25", null]) expect(parseWaveSize(bad)).toBeUndefined();
  });
});

describe("rolloutOrder", () => {
  it("is deterministic per recipe, puts canaries first, and de-duplicates", () => {
    const first = rolloutOrder("job-timeouts", repos);
    expect(rolloutOrder("job-timeouts", [...repos].reverse())).toEqual(first);
    expect(new Set(first).size).toBe(repos.length);
    expect(rolloutOrder("other-recipe", repos)).not.toEqual(first);
    const withCanaries = rolloutOrder("job-timeouts", [...repos, "acme/repo-01"], ["acme/repo-19", "acme/unknown", "acme/repo-03"]);
    expect(withCanaries.slice(0, 2)).toEqual(["acme/repo-19", "acme/repo-03"]);
    expect(withCanaries).toHaveLength(20);
  });
});

describe("planRollout", () => {
  it("starts with the first wave (one canary)", () => {
    const plan = planRollout({ id: "r", targets: statuses({}), canaries: ["acme/repo-07"] });
    expect(plan).toMatchObject({ action: "advance", wave: 0, slots: 1 });
    expect(plan.candidates[0]).toBe("acme/repo-07");
  });

  it("waits while changes are pending", () => {
    const plan = planRollout({ id: "r", targets: statuses({ "acme/repo-00": "pending" }) });
    expect(plan.action).toBe("wait");
  });

  it("advances to the next wave after the previous one passed", () => {
    const plan = planRollout({ id: "r", targets: statuses({ "acme/repo-00": "passed" }) });
    expect(plan).toMatchObject({ action: "advance", wave: 1, slots: 2 });
    const third = planRollout({ id: "r", targets: statuses({ "acme/repo-00": "passed", "acme/repo-01": "passed", "acme/repo-02": "passed" }) });
    expect(third).toMatchObject({ action: "advance", wave: 2, slots: 2 });
  });

  it("halts on any failure before the sample minimum", () => {
    const plan = planRollout({ id: "r", targets: statuses({ "acme/repo-00": "passed", "acme/repo-01": "failed" }) });
    expect(plan.action).toBe("halt");
    expect(plan.reason).toContain("1 of 2");
  });

  it("halts when changes produced no CI evidence", () => {
    expect(planRollout({ id: "r", targets: statuses({ "acme/repo-00": "unknown" }) }).action).toBe("halt");
  });

  it("gates on the compatibility lower bound once there are enough samples", () => {
    const passing = Object.fromEntries(repos.slice(0, 9).map((repo) => [repo, "passed" as const]));
    const good = planRollout({ id: "r", targets: statuses({ ...passing, "acme/repo-09": "failed" }), config: { ...DEFAULT_ROLLOUT, minCompatibility: 0.55 } });
    expect(good.action).toBe("advance");
    expect(good.compatibility.total).toBe(10);
    const strict = planRollout({ id: "r", targets: statuses({ ...passing, "acme/repo-09": "failed" }), config: { ...DEFAULT_ROLLOUT, minCompatibility: 0.7 } });
    expect(strict.action).toBe("halt");
    expect(strict.reason).toMatch(/lower bound \d+% is below the required 70%/);
  });

  it("ignores repositories where the recipe does not apply", () => {
    const plan = planRollout({ id: "r", targets: statuses({ "acme/repo-00": "not-applicable" }, repos.slice(0, 1)) });
    expect(plan).toMatchObject({ action: "complete", reason: "No applicable repositories." });
  });

  it("completes when every applicable repository was attempted", () => {
    const all = Object.fromEntries(repos.map((repo) => [repo, "passed" as const]));
    expect(planRollout({ id: "r", targets: statuses(all) }).action).toBe("complete");
  });

  it("counts states", () => {
    const plan = planRollout({ id: "r", targets: statuses({ "acme/repo-00": "passed", "acme/repo-01": "pending" }) });
    expect(plan.counts).toMatchObject({ passed: 1, pending: 1, untouched: 18 });
  });
});

describe("parseRolloutTargets", () => {
  it("parses repositories, canaries, and rollout settings", () => {
    const parsed = parseRolloutTargets("repositories: [acme/a, acme/b, acme/a]\ncanaries: [acme/b]\nrollout:\n  waves: [2, '50%']\n  minSamples: 3\n  minCompatibility: 0.8\n");
    expect(parsed.problems).toEqual([]);
    expect(parsed).toMatchObject({ repositories: ["acme/a", "acme/b"], canaries: ["acme/b"], config: { waves: [2, "50%"], minSamples: 3, minCompatibility: 0.8 } });
  });

  it("defaults the rollout settings", () => {
    expect(parseRolloutTargets("repositories: [acme/a]").config).toEqual(DEFAULT_ROLLOUT);
  });

  it("reports invalid input", () => {
    expect(parseRolloutTargets("{").problems[0]).toMatch(/Invalid YAML/);
    expect(parseRolloutTargets("{}").problems).toContain("repositories must list at least one owner/name repository.");
    const bad = parseRolloutTargets("repositories: [acme/a, nope]\ncanaries: [acme/z]\nrollout:\n  waves: [0]\n  minSamples: 0\n  minCompatibility: 2\n");
    expect(bad.problems).toEqual([
      "repositories must only contain owner/name repositories.",
      "canary acme/z is not in repositories.",
      'rollout.waves must be a non-empty list of positive integers or percentages such as "25%".',
      "rollout.minSamples must be a positive integer.",
      "rollout.minCompatibility must be a number between 0 and 1.",
    ]);
  });
});
