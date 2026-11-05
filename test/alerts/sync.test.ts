import { describe, expect, it } from "vitest";
import { planAlertSync, type AlertSyncInput, type ExistingAlertIssue } from "../../src/alerts/sync.js";
import { parseMarker } from "../../src/issues/markers.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { seriesOf, stable } from "./fixtures.js";

const now = new Date(Date.UTC(2026, 10, 3));

function input(overrides: Partial<AlertSyncInput>): AlertSyncInput {
  return {
    owner: "acme",
    repo: "widgets",
    branch: "main",
    workflowId: 7,
    workflowName: "CI",
    series: [],
    existing: [],
    config: DEFAULT_CONFIG.alerts,
    now,
    ...overrides,
  };
}

const regressed = [seriesOf([...stable(30, 300), ...stable(5, 480, 50)]), seriesOf([...stable(30, 200), ...stable(5, 380, 50)], { jobKey: "build" })];

function existingFrom(body: string, overrides: Partial<ExistingAlertIssue> = {}): ExistingAlertIssue {
  const parsed = parseMarker(body);
  if (!parsed) throw new Error("missing marker");
  return {
    number: 41,
    title: "old",
    state: "open",
    fingerprint: parsed.fingerprint,
    attributes: parsed.attributes,
    ...(parsed.attributes.signature ? { signature: parsed.attributes.signature } : {}),
    ...overrides,
  };
}

describe("planAlertSync", () => {
  it("does not treat a missing tracked series as recovery", () => {
    const first = planAlertSync(input({ series: regressed })).actions[0];
    if (first?.type !== "create") throw new Error("expected create");
    const onlyWorkflow = seriesOf([...stable(30, 300), ...stable(3, 300)]);
    const plan = planAlertSync(input({ series: [onlyWorkflow], existing: [existingFrom(first.desired.body)] }));
    expect(plan.alerts).toEqual([]);
    expect(plan.actions).toEqual([]);
  });

  it("scopes detection, recovery and issue identity to a workload context", () => {
    const a = regressed.map((series) => ({ ...series, contextKey: "context-a" }));
    const first = planAlertSync(input({ contextKey: "context-a", series: a })).actions[0];
    if (first?.type !== "create") throw new Error("expected create");
    expect(parseMarker(first.desired.body)).toMatchObject({ fingerprint: "duration:7/context-a", attributes: { context: "context-a" } });
    const existing = existingFrom(first.desired.body);
    const other = { ...seriesOf([...stable(30, 300), ...stable(3, 300)]), contextKey: "context-b" };
    expect(planAlertSync(input({ contextKey: "context-a", series: [other], existing: [existing] })).actions).toEqual([]);
    expect(planAlertSync(input({ contextKey: "context-b", series: [other], existing: [existing] })).actions).toEqual([]);
    const matching = a.map((series) => ({ ...series, points: seriesOf(stable(40, 100)).points }));
    expect(planAlertSync(input({ contextKey: "context-a", series: matching, existing: [existing] })).actions).toMatchObject([{ type: "close", number: 41 }]);
  });

  it("supersedes legacy and abandoned same-branch contexts while keeping their dismissals", () => {
    const b = regressed.map((series) => ({ ...series, contextKey: "context-b" }));
    const legacy: ExistingAlertIssue = { number: 30, title: "old", state: "open", fingerprint: "duration:7", attributes: {} };
    const first = planAlertSync(input({ contextKey: "context-a", series: regressed.map((series) => ({ ...series, contextKey: "context-a" })) })).actions[0];
    if (first?.type !== "create") throw new Error("expected create");
    const contextA = existingFrom(first.desired.body);
    const otherBranch = existingFrom(first.desired.body.replace("branch=main", "branch=release"), { number: 42 });

    const unknownWindow = planAlertSync(input({ contextKey: "context-b", series: b, existing: [legacy, contextA, otherBranch] }));
    expect(unknownWindow.actions.map((action) => [action.type, "number" in action ? action.number : undefined])).toEqual([["close", 30], ["create", undefined]]);

    const abandoned = planAlertSync(input({ contextKey: "context-b", series: b, existing: [legacy, contextA, otherBranch], activeContexts: new Set(["context-b"]) }));
    expect(abandoned.actions.map((action) => [action.type, "number" in action ? action.number : undefined])).toEqual([["close", 30], ["close", 41], ["create", undefined]]);
    const alternating = planAlertSync(input({ contextKey: "context-b", series: b, existing: [contextA], activeContexts: new Set(["context-a", "context-b"]) }));
    expect(alternating.actions.map((action) => action.type)).toEqual(["create"]);

    const dismissed = { ...legacy, state: "closed" as const, stateReason: "not_planned", closedAt: "2026-10-30T00:00:00Z" };
    const snoozed = planAlertSync(input({ contextKey: "context-b", series: b, existing: [dismissed] }));
    expect(snoozed.actions).toEqual([]);
    expect(snoozed.skipped).toEqual([{ fingerprint: "duration:7/context-b", reason: "dismissed", number: 30 }]);
  });

  it("opens one issue per workflow listing every anomalous series", () => {
    const plan = planAlertSync(input({ series: regressed }));
    expect(plan.alerts).toHaveLength(2);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    if (action?.type !== "create") throw new Error("expected create");
    expect(action.desired.title).toBe('CI slowdown: "CI" is 59% slower (regression)');
    expect(action.desired.labels).toEqual(["cicd-optimizer", "alert:duration", "severity:error"]);
    expect(action.desired.body).toContain("| Job `build` | regression |");
    expect(action.desired.body).toContain("xychart-beta");
    expect(action.desired.body).toContain("https://github.com/acme/widgets/compare/sha01029...sha01030");
    const parsed = parseMarker(action.desired.body);
    expect(parsed).toMatchObject({ kind: "alert", fingerprint: "duration:7" });
    expect(Object.keys(JSON.parse(parsed?.attributes.baselines ?? "{}") as object).sort()).toEqual(["*", "build"]);
  });

  it("does nothing without anomalies or an open issue", () => {
    expect(planAlertSync(input({ series: [seriesOf(stable(40, 300))] })).actions).toEqual([]);
  });

  it("respects a recent not-planned dismissal (snooze) and alerts again afterwards", () => {
    const dismissed = { number: 12, title: "x", state: "closed" as const, stateReason: "not_planned", fingerprint: "duration:7", attributes: {} };
    const recent = planAlertSync(input({ series: regressed, existing: [{ ...dismissed, closedAt: "2026-10-30T00:00:00Z" }] }));
    expect(recent.actions).toEqual([]);
    expect(recent.skipped).toEqual([{ fingerprint: "duration:7", reason: "dismissed", number: 12 }]);
    const old = planAlertSync(input({ series: regressed, existing: [{ ...dismissed, closedAt: "2026-09-01T00:00:00Z" }] }));
    expect(old.actions.map((action) => action.type)).toEqual(["create"]);
    if (old.actions[0]?.type === "create") expect(old.actions[0].desired.body).toContain("previously regressed in #12");
  });

  it("refreshes an open issue silently when only the latest run changes", () => {
    const first = planAlertSync(input({ series: regressed })).actions[0];
    if (first?.type !== "create") throw new Error("expected create");
    const existing = existingFrom(first.desired.body);
    const next = regressed.map((series) => ({ ...series, points: [...series.points.slice(1), { ...series.points.at(-1)!, runId: 2000 }] }));
    const plan = planAlertSync(input({ series: next, existing: [existing] }));
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action).toMatchObject({ type: "update", number: 41 });
    expect(action && "comment" in action ? action.comment : undefined).toBeUndefined();
    expect(planAlertSync(input({ series: regressed, existing: [existing] })).actions).toEqual([]);
  });

  it("comments when the set of anomalous series changes", () => {
    const first = planAlertSync(input({ series: regressed.slice(0, 1) })).actions[0];
    if (first?.type !== "create") throw new Error("expected create");
    const plan = planAlertSync(input({ series: regressed, existing: [existingFrom(first.desired.body)] }));
    const action = plan.actions[0];
    if (action?.type !== "update") throw new Error("expected update");
    expect(action.comment).toContain("`build` regression");
  });

  it("closes the issue only after recovery relative to the original baseline", () => {
    const first = planAlertSync(input({ series: regressed.slice(0, 1) })).actions[0];
    if (first?.type !== "create") throw new Error("expected create");
    const existing = existingFrom(first.desired.body);

    const recovered = seriesOf([...stable(30, 300), ...stable(5, 480, 50), ...stable(3, 300, 80)]);
    const close = planAlertSync(input({ series: [recovered], existing: [existing] }));
    expect(close.actions).toMatchObject([{ type: "close", number: 41, fingerprint: "duration:7" }]);

    // The slow runs became the new normal: detection stops firing but this is not a recovery.
    const absorbed = seriesOf([...stable(30, 300), ...stable(40, 480, 50)]);
    const stillSlow = planAlertSync(input({ series: [absorbed], existing: [existing] }));
    expect(stillSlow.alerts).toEqual([]);
    expect(stillSlow.actions).toEqual([]);
  });
});
