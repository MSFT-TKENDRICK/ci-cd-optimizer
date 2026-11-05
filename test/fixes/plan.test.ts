import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type FixesConfig } from "../../src/lint/config.js";
import type { AnalysisInput, Diagnostic, LintResult } from "../../src/lint/types.js";
import { parseCommands } from "../../src/fixes/commands.js";
import {
  branchFor,
  computeFixChanges,
  groupName,
  isIgnored,
  planFixPullRequests,
  type ExistingFixPullRequest,
  type FixChange,
} from "../../src/fixes/plan.js";
import { fixBody, fixTitle } from "../../src/fixes/render.js";
import { parseMarker } from "../../src/issues/markers.js";

const fixes = (overrides: Partial<FixesConfig> = {}): FixesConfig => ({ ...DEFAULT_CONFIG.fixes, enabled: true, ...overrides });

interface FakeRule {
  id: string;
  ruleset: string;
  from: string;
  to: string;
}

const RULES: FakeRule[] = [
  { id: "hermeticity/pin-runner", ruleset: "hermeticity", from: "ubuntu-latest", to: "ubuntu-24.04" },
  { id: "workflow/timeout", ruleset: "workflow", from: "runs-on:", to: "timeout-minutes: 15\n    runs-on:" },
];

function diagnostic(rule: FakeRule, path: string, start: number, content: string): Diagnostic {
  const line = content.slice(0, start).split("\n").length;
  return {
    ruleId: rule.id,
    ruleset: rule.ruleset,
    severity: "warn",
    message: `replace ${rule.from}`,
    path,
    line,
    column: 1,
    impact: "medium",
    confidence: "high",
    fingerprint: `${rule.id}:${path}:${line}`,
    docsUrl: `https://example.test/${rule.id}`,
    kind: "workflow",
    fix: { description: `use ${rule.to.split("\n")[0]}`, edits: [{ path, start, end: start + rule.from.length, text: rule.to }] },
  };
}

/** A tiny deterministic linter: each rule reports every occurrence of `from` that has not been fixed yet. */
function fakeLint(input: AnalysisInput): LintResult {
  const diagnostics: Diagnostic[] = [];
  for (const file of input.files) {
    for (const rule of RULES) {
      let index = file.content.indexOf(rule.from);
      while (index >= 0) {
        const fixed = rule.id === "workflow/timeout" && file.content.slice(Math.max(0, index - 25), index).includes("timeout-minutes");
        if (!fixed) diagnostics.push(diagnostic(rule, file.path, index, file.content));
        index = file.content.indexOf(rule.from, index + 1);
      }
    }
  }
  return { diagnostics, skipped: [], parseProblems: [], filesAnalyzed: input.files.length, rulesRun: RULES.length, suppressed: 0, durationMs: 0 };
}

const WORKFLOW = ["jobs:", "  test:", "    runs-on: ubuntu-latest", "  lint:", "    runs-on: ubuntu-latest", ""].join("\n");
const input = (files = [{ path: ".github/workflows/ci.yml", content: WORKFLOW }]): AnalysisInput => ({ files, mode: "repository", inventoryComplete: true });

describe("grouping and ignores", () => {
  it("uses the first matching named group, falling back to the ruleset", () => {
    const config = fixes({ groups: { pinning: { rules: ["hermeticity/pin-runner"] }, everything: { rulesets: ["hermeticity", "workflow"] } } });
    expect(groupName({ ruleId: "hermeticity/pin-runner", ruleset: "hermeticity" }, config)).toBe("pinning");
    expect(groupName({ ruleId: "hermeticity/pin-actions", ruleset: "hermeticity" }, config)).toBe("everything");
    expect(groupName({ ruleId: "caching/setup-cache", ruleset: "caching" }, config)).toBe("caching");
  });

  it("matches ignores by rule id, ruleset wildcard, and optional path globs", () => {
    const config = fixes({ ignore: [{ rule: "caching/*" }, { rule: "workflow/timeout", paths: [".github/workflows/release-*.yml"] }] });
    expect(isIgnored({ ruleId: "caching/cache-key", path: "a.yml" }, config)).toBe(true);
    expect(isIgnored({ ruleId: "workflow/timeout", path: ".github/workflows/release-npm.yml" }, config)).toBe(true);
    expect(isIgnored({ ruleId: "workflow/timeout", path: ".github/workflows/ci.yml" }, config)).toBe(false);
    expect(isIgnored({ ruleId: "workflow/timeout", path: "x" }, fixes(), { rules: new Set(["workflow/timeout"]), groups: new Set() })).toBe(true);
  });

  it("derives safe branch names", () => {
    expect(branchFor("Docker Layers!", fixes())).toBe("cicd-optimizer/docker-layers");
  });
});

describe("computeFixChanges", () => {
  it("builds one independent change set per group from the unmodified base", () => {
    const changes = computeFixChanges({ input: input(), lint: fakeLint, config: fixes() });
    expect(changes.map((change) => change.group)).toEqual(["hermeticity", "workflow"]);
    const [hermetic, workflow] = changes as [FixChange, FixChange];
    expect(hermetic.files[0]?.content).toBe(WORKFLOW.replaceAll("ubuntu-latest", "ubuntu-24.04"));
    expect(hermetic.applied).toHaveLength(2);
    expect(workflow.files[0]?.content).toContain("timeout-minutes: 15\n    runs-on: ubuntu-latest");
    expect(workflow.files[0]?.content).not.toContain("ubuntu-24.04");
    expect(hermetic.branch).toBe("cicd-optimizer/hermeticity");
  });

  it("produces stable signatures that change only when the resulting contents change", () => {
    const first = computeFixChanges({ input: input(), lint: fakeLint, config: fixes() });
    const again = computeFixChanges({ input: input(), lint: fakeLint, config: fixes() });
    expect(again.map((change) => change.signature)).toEqual(first.map((change) => change.signature));
    const other = computeFixChanges({ input: input([{ path: ".github/workflows/ci.yml", content: `${WORKFLOW}# comment\n` }]), lint: fakeLint, config: fixes() });
    expect(other[0]?.signature).not.toBe(first[0]?.signature);
  });

  it("re-lints and applies deferred fixes until conflicts are resolved", () => {
    const content = "a: ubuntu-latest\n";
    let calls = 0;
    const overlapping = (analysis: AnalysisInput): LintResult => {
      calls += 1;
      const file = analysis.files[0]!;
      const diagnostics: Diagnostic[] = [];
      const index = file.content.indexOf("ubuntu-latest");
      const rule = RULES[0]!;
      if (index >= 0) diagnostics.push(diagnostic(rule, file.path, index, file.content), { ...diagnostic(rule, file.path, index, file.content), fingerprint: "dup" });
      const label = file.content.indexOf("a:");
      if (label >= 0 && index < 0) diagnostics.push({ ...diagnostic(rule, file.path, label, file.content), fix: { description: "rename", edits: [{ path: file.path, start: label, end: label + 2, text: "b:" }] } });
      return { ...fakeLint(analysis), diagnostics };
    };
    const changes = computeFixChanges({ input: input([{ path: "x.yml", content }]), lint: overlapping, config: fixes() });
    expect(changes[0]?.files[0]?.content).toBe("b: ubuntu-24.04\n");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("skips ignored rules and dismissed groups, and returns nothing when no file changes", () => {
    const ignored = computeFixChanges({
      input: input(),
      lint: fakeLint,
      config: fixes({ ignore: [{ rule: "workflow/*" }] }),
      dismissed: { rules: new Set(), groups: new Set(["hermeticity"]) },
    });
    expect(ignored).toEqual([]);
  });
});

function change(group: string, signature: string): FixChange {
  return { group, branch: `cicd-optimizer/${group}`, files: [{ path: "a", content: signature }], applied: [], rules: [`${group}/rule`], signature };
}

function pr(overrides: Partial<ExistingFixPullRequest> & Pick<ExistingFixPullRequest, "number" | "group">): ExistingFixPullRequest {
  return { state: "open", merged: false, signature: "s1", commitSha: "c1", headSha: "c1", branch: `cicd-optimizer/${overrides.group}`, ...overrides };
}

describe("planFixPullRequests", () => {
  it.each(["base-1", "base-2"])("reconciles a completed rebase against the current base (%s)", (baseSha) => {
    const pendingUpdate = { fromSha: "c1", commitSha: "c2", signature: "s2", baseSha: "base-1", rules: ["a/rule"] };
    const plan = planFixPullRequests([change("a", "s2")], [pr({ number: 1, group: "a", headSha: "c2", pendingUpdate })], {
      openPullRequestsLimit: 5, baseSha, rebase: new Set(["a"]),
    });
    expect(plan.actions.map((action) => action.type)).toEqual(baseSha === "base-1" ? ["metadata"] : ["metadata", "update"]);
    expect(plan.actions[0]).toMatchObject({ recoverUpdate: true });
  });

  it("does not skip an uncommitted rebase intent merely because the old signature still matches", () => {
    const pendingUpdate = { fromSha: "c1", commitSha: "c2", signature: "s1", baseSha: "base-1", rules: ["a/rule"] };
    const plan = planFixPullRequests([change("a", "s1")], [pr({ number: 1, group: "a", pendingUpdate })], { openPullRequestsLimit: 5 });
    expect(plan.actions.map((action) => action.type)).toEqual(["metadata", "update"]);
  });

  it("repairs pending metadata independently of changed or human-edited branch contents", () => {
    const existing = [pr({ number: 1, group: "a", headSha: "human", labels: ["CI"], pendingReviewers: ["alice", "removed"] })];
    const plan = planFixPullRequests([change("a", "s1")], existing, {
      openPullRequestsLimit: 0, labels: ["cicd-optimizer", "ci"], reviewers: ["alice"],
    });
    expect(plan.actions).toEqual([{ type: "metadata", number: 1, group: "a", labels: ["cicd-optimizer"], reviewers: ["alice"] }]);
    expect(plan.skipped).toEqual([{ group: "a", reason: "edited", number: 1 }]);
  });

  it("does not request reviews for a PR that is being closed", () => {
    const plan = planFixPullRequests([], [pr({ number: 1, group: "a", labels: [], pendingReviewers: ["alice"] })], {
      openPullRequestsLimit: 5, labels: ["cicd-optimizer"], reviewers: ["alice"],
    });
    expect(plan.actions.map((action) => action.type)).toEqual(["metadata", "close"]);
    expect(plan.actions[0]).toMatchObject({ reviewers: [] });
  });

  it("creates new pull requests within the open limit (0 disables)", () => {
    const plan = planFixPullRequests([change("a", "s1"), change("b", "s1"), change("c", "s1")], [], { openPullRequestsLimit: 2 });
    expect(plan.actions.map((action) => action.type)).toEqual(["create", "create"]);
    expect(plan.skipped).toEqual([{ group: "c", reason: "limit" }]);
    expect(planFixPullRequests([change("a", "s1")], [], { openPullRequestsLimit: 0 }).actions).toEqual([]);
  });

  it("leaves up-to-date pull requests alone and rebuilds changed ones", () => {
    const plan = planFixPullRequests([change("a", "s1"), change("b", "s2")], [pr({ number: 1, group: "a" }), pr({ number: 2, group: "b" })], { openPullRequestsLimit: 5 });
    expect(plan.skipped).toEqual([{ group: "a", reason: "up-to-date", number: 1 }]);
    expect(plan.actions).toEqual([{ type: "update", number: 2, change: change("b", "s2") }]);
  });

  it("never overwrites pull requests someone else pushed to, unless recreate is requested", () => {
    const existing = [pr({ number: 1, group: "a", headSha: "human" })];
    expect(planFixPullRequests([change("a", "s2")], existing, { openPullRequestsLimit: 5, rebase: new Set(["a"]) }).skipped).toEqual([
      { group: "a", reason: "edited", number: 1 },
    ]);
    expect(planFixPullRequests([change("a", "s2")], existing, { openPullRequestsLimit: 5, recreate: new Set(["a"]) }).actions[0]?.type).toBe("update");
  });

  it("does not rebuild or close a PR without verifiable bot ownership", () => {
    const missingCommit = pr({ number: 1, group: "a" });
    delete missingCommit.commitSha;
    const missingHead = pr({ number: 2, group: "b" });
    delete missingHead.headSha;
    const plan = planFixPullRequests([change("a", "s2")], [missingCommit, missingHead], { openPullRequestsLimit: 5 });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([
      { group: "b", reason: "edited", number: 2 },
      { group: "a", reason: "edited", number: 1 },
    ]);
  });

  it("rebases on request even when the fixes are unchanged", () => {
    const plan = planFixPullRequests([change("a", "s1")], [pr({ number: 1, group: "a" })], { openPullRequestsLimit: 5, rebase: new Set(["a"]) });
    expect(plan.actions[0]).toMatchObject({ type: "update", number: 1 });
  });

  it("does not reopen a declined change, but proposes a different one", () => {
    const declined = [pr({ number: 1, group: "a", state: "closed" })];
    expect(planFixPullRequests([change("a", "s1")], declined, { openPullRequestsLimit: 5 }).skipped).toEqual([{ group: "a", reason: "declined", number: 1 }]);
    expect(planFixPullRequests([change("a", "s2")], declined, { openPullRequestsLimit: 5 }).actions[0]?.type).toBe("create");
    const merged = [pr({ number: 1, group: "a", state: "closed", merged: true })];
    expect(planFixPullRequests([change("a", "s1")], merged, { openPullRequestsLimit: 5 }).actions[0]?.type).toBe("create");
  });

  it("closes pull requests whose fixes are no longer needed, freeing capacity", () => {
    const plan = planFixPullRequests([change("b", "s1")], [pr({ number: 1, group: "a" })], { openPullRequestsLimit: 1 });
    expect(plan.actions.map((action) => action.type)).toEqual(["close", "create"]);
    expect(plan.actions[0]).toMatchObject({ number: 1, branch: "cicd-optimizer/a" });
    const edited = planFixPullRequests([], [pr({ number: 1, group: "a", headSha: "human" })], { openPullRequestsLimit: 1 });
    expect(edited.actions).toEqual([]);
    expect(edited.skipped[0]?.reason).toBe("edited");
  });
});

describe("commands", () => {
  it("parses Dependabot-style commands, one per line", () => {
    expect(
      parseCommands(
        [
          "Thanks!",
          "@cicd-optimizer rebase",
          "@ci-cd-optimizer RECREATE",
          "@cicd-optimizer[bot] ignore this rule hermeticity/pin-runner",
          "@cicd-optimizer ignore  this rule",
          "@cicd-optimizer ignore this group",
          "@cicd-optimizer close",
          "@cicd-optimizer dance",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "rebase" },
      { type: "recreate" },
      { type: "ignore-rule", rule: "hermeticity/pin-runner" },
      { type: "ignore-rule" },
      { type: "ignore-group" },
      { type: "close" },
    ]);
    expect(parseCommands("please @cicd-optimizer rebase")).toEqual([]);
    expect(parseCommands(null)).toEqual([]);
  });
});

describe("render", () => {
  it("renders a reviewable pull request with a marker recording the pushed commit", () => {
    const [hermetic] = computeFixChanges({ input: input(), lint: fakeLint, config: fixes() });
    const body = fixBody(hermetic!, { rules: [], commitSha: "abc", ignoredRules: ["workflow/timeout"] });
    expect(fixTitle(hermetic!)).toBe("ci(hermeticity): fix hermeticity/pin-runner (2 changes)");
    expect(body).toContain("| [`hermeticity/pin-runner`](https://example.test/hermeticity/pin-runner) | 2 | medium |");
    expect(body).toContain("- `.github/workflows/ci.yml`");
    expect(body).toContain("@cicd-optimizer recreate");
    expect(parseMarker(body)).toEqual({
      kind: "fix",
      fingerprint: "group:hermeticity",
      attributes: { signature: hermetic!.signature, commit: "abc", rules: "hermeticity/pin-runner", ignored: "workflow/timeout" },
    });
  });
});
