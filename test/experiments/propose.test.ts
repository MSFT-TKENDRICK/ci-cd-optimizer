import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import type { ExperimentPullRequest, ExperimentState } from "../../src/experiments/github.js";
import { generatorContext, knownExperimentNames, validateProposal } from "../../src/experiments/propose.js";
import { sampleManifest } from "./fixtures.js";

const config = DEFAULT_HILL_CLIMB_CONFIG;
const now = new Date("2026-11-03T00:00:00Z");

const proposal = (overrides: Record<string, unknown> = {}) => stringify({ ...sampleManifest(), ...overrides });

const running = (name: string, open = true): ExperimentState => ({
  name,
  trunk: { number: 1, nodeId: "N", state: open ? "open" : "closed", merged: false, draft: true, title: `experiment(${name}): t`, body: "", labels: [], head: `experiments/${name}/trunk`, headSha: "s", base: "main", experiment: name, arm: "trunk" },
  arms: [],
});

describe("validateProposal", () => {
  it("overrides server-controlled fields", () => {
    const result = validateProposal(proposal({ createdAt: "2020-01-01T00:00:00Z", status: "promoted", winner: "lockfile" }), { config, running: [], knownNames: [], now });
    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({ createdAt: "2026-11-03T00:00:00.000Z", expiresAt: "2026-11-17T00:00:00.000Z", status: "running" });
    expect(result.manifest?.winner).toBeUndefined();
    expect(result.rubric?.passed).toBe(true);
  });

  it("enforces the rubric bar, unique names, and the concurrency budget", () => {
    const weak = proposal({ rubric: { scores: { impact: 2, evidence: 2, safety: 3, generality: 2, measurability: 2 }, rationale: "" } });
    expect(validateProposal(weak, { config, running: [], knownNames: [], now }).errors).toEqual([expect.stringMatching(/^rubric: weighted score 2\.2 is below the 3\.5 bar$/)]);

    const partial = proposal({ rubric: { scores: { impact: 5 }, rationale: "" } });
    expect(validateProposal(partial, { config, running: [], knownNames: [], now }).errors[0]).toMatch(/^rubric: missing scores for evidence, safety/);

    const busy = [running("a"), running("b"), running("c"), running("d", false)];
    const errors = validateProposal(proposal(), { config, running: busy, knownNames: ["setup-cache-yarn"], now }).errors;
    expect(errors).toEqual([expect.stringMatching(/^name: an experiment named "setup-cache-yarn"/), "selection: 3 experiments are already running (max 3)"]);
  });

  it("reports YAML and schema problems", () => {
    expect(validateProposal("a: [", { config, running: [], knownNames: [], now }).errors[0]).toMatch(/^manifest: /);
    expect(validateProposal("- 1", { config, running: [], knownNames: [], now }).errors).toEqual(["manifest: expected a YAML mapping"]);
    const result = validateProposal(proposal({ name: "Bad Name" }), { config, running: [], knownNames: [], now });
    expect(result.manifest).toBeUndefined();
    expect(result.errors[0]).toMatch(/^name: /);
  });
});

describe("generatorContext", () => {
  const pull = (experiment: string, overrides: Partial<ExperimentPullRequest>): ExperimentPullRequest => ({
    ...running(experiment).trunk!,
    title: `experiment(${experiment}): Try ${experiment}`,
    ...overrides,
  });

  it("summarises rubric, findings, running work, and history", () => {
    const text = generatorContext({
      config,
      diagnostics: [
        { ruleId: "caching/setup-cache", severity: "warn", message: "m", path: "a", line: 1, column: 1 },
        { ruleId: "caching/setup-cache", severity: "warn", message: "m", path: "b", line: 1, column: 1 },
        { ruleId: "workflow/job-timeout", severity: "warn", message: "m", path: "a", line: 1, column: 1 },
      ] as never,
      telemetry: "critical path: build → test",
      running: [running("live")],
      history: [
        pull("won", { merged: true, state: "closed" }),
        pull("nope", { state: "closed", labels: ["experiment:rejected"] }),
        pull("review", { labels: ["experiment:promote"] }),
        { ...pull("won", {}), arm: "fast" },
      ],
      rules: [{ id: "caching/setup-cache", description: "Cache dependencies" }],
    });
    expect(text).toContain("| `caching/setup-cache` | 2 |\n| `workflow/job-timeout` | 1 |");
    expect(text).toContain("critical path: build → test");
    expect(text).toContain("- `live` — experiment(live): t (0 arm PRs)");
    expect(text).toContain("- `won` — Try won → **promoted and merged**");
    expect(text).toContain("- `nope` — Try nope → **rejected**");
    expect(text).toContain("- `review` — Try review → **awaiting promotion review**");
    expect(text).toContain("| `precision` | corpus | maximize | 0.35 | 2% |");
    expect(text).toContain("at least 2.0%");
  });

  it("collects unique known names", () => {
    expect(knownExperimentNames([running("a").trunk!, running("a").trunk!, running("b").trunk!])).toEqual(["a", "b"]);
  });
});
