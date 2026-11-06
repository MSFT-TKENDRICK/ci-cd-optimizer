import { describe, expect, it } from "vitest";
import { findMarker, marker, parseMarker, signatureOf } from "../../src/issues/markers.js";
import { planIssueSync, type DesiredIssue, type ExistingIssue } from "../../src/issues/plan.js";

function desired(fingerprint: string, overrides: Partial<DesiredIssue> = {}): DesiredIssue {
  return {
    fingerprint,
    signature: `sig-${fingerprint}`,
    title: `Title ${fingerprint}`,
    body: "body",
    labels: ["cicd-optimizer"],
    assignees: [],
    assignCopilot: false,
    priority: 1,
    ...overrides,
  };
}

function existing(number: number, fingerprint: string, overrides: Partial<ExistingIssue> = {}): ExistingIssue {
  return { number, fingerprint, signature: `sig-${fingerprint}`, state: "open", title: `Title ${fingerprint}`, ...overrides };
}

const options = { maxOpen: 10, closeResolved: true };

describe("markers", () => {
  it("finds a marker of a given kind among several", () => {
    const body = `${marker("fix", "group:recipe-x", { signature: "s" })}\n${marker("recipe", "x", { revision: "2" })}`;
    expect(parseMarker(body)?.kind).toBe("fix");
    expect(findMarker(body, "recipe")).toEqual({ kind: "recipe", fingerprint: "x", attributes: { revision: "2" } });
    expect(findMarker(body, "alert")).toBeUndefined();
    expect(findMarker(null, "fix")).toBeUndefined();
  });

  it("round-trips kind, fingerprint and encoded attributes", () => {
    const text = marker("finding", "rule:caching/setup-cache", { signature: "abc", note: "a b=c", empty: "" });
    expect(text).toBe("<!-- cicd-optimizer:finding fingerprint=rule%3Acaching%2Fsetup-cache signature=abc note=a%20b%3Dc -->");
    expect(parseMarker(`intro\n${text}\nrest`)).toEqual({
      kind: "finding",
      fingerprint: "rule:caching/setup-cache",
      attributes: { signature: "abc", note: "a b=c" },
    });
    expect(parseMarker("no marker")).toBeUndefined();
    expect(parseMarker(null)).toBeUndefined();
  });

  it("computes stable short signatures", () => {
    expect(signatureOf(["a", "b"])).toHaveLength(16);
    expect(signatureOf(["a", "b"])).toBe(signatureOf(["a", "b"]));
    expect(signatureOf(["a", "b"])).not.toBe(signatureOf(["ab"]));
  });
});

describe("planIssueSync", () => {
  it("creates new issues and leaves unchanged ones alone", () => {
    const plan = planIssueSync([existing(1, "a")], [desired("a"), desired("b")], options);
    expect(plan.actions).toEqual([{ type: "create", desired: desired("b") }]);
  });

  it("updates open issues when the signature or title changes", () => {
    const plan = planIssueSync([existing(1, "a"), existing(2, "b")], [desired("a", { signature: "new" }), desired("b", { title: "Renamed" })], options);
    expect(plan.actions.map((action) => [action.type, "number" in action ? action.number : 0])).toEqual([
      ["update", 1],
      ["update", 2],
    ]);
  });

  it("retries pending assignment even when the finding is unchanged", () => {
    const issue = desired("a", { assignCopilot: true });
    expect(planIssueSync([existing(13, "a", { copilotPending: true })], [issue], options).actions).toEqual([
      { type: "assign", number: 13, desired: issue },
    ]);
    expect(planIssueSync([existing(13, "a", { copilotPending: false })], [issue], options).actions).toEqual([]);
    expect(planIssueSync([existing(13, "a", { copilotPending: true })], [desired("a")], options).actions).toEqual([]);
    expect(planIssueSync([existing(13, "a", { copilotPending: true })], [{ ...issue, signature: "new" }], options).actions.map((action) => action.type)).toEqual(["update"]);
  });

  it("closes resolved issues unless closeResolved is false", () => {
    expect(planIssueSync([existing(1, "a")], [], options).actions).toMatchObject([{ type: "close", number: 1, fingerprint: "a" }]);
    expect(planIssueSync([existing(1, "a")], [], { ...options, closeResolved: false }).actions).toEqual([]);
  });

  it("treats not-planned closures as dismissals and reopens completed ones when the finding returns", () => {
    const plan = planIssueSync(
      [existing(1, "a", { state: "closed", stateReason: "not_planned" }), existing(2, "b", { state: "closed", stateReason: "completed" })],
      [desired("a"), desired("b")],
      options,
    );
    expect(plan.actions).toEqual([{ type: "reopen", number: 2, desired: desired("b") }]);
    expect(plan.skipped).toEqual([{ fingerprint: "a", reason: "dismissed", number: 1 }]);
  });

  it("uses the newest issue when a fingerprint has history", () => {
    const plan = planIssueSync(
      [existing(1, "a", { state: "closed", stateReason: "not_planned" }), existing(5, "a", { state: "closed", stateReason: "completed" })],
      [desired("a")],
      options,
    );
    expect(plan.actions).toEqual([{ type: "reopen", number: 5, desired: desired("a") }]);
  });

  it("opens the highest-priority issues first within maxOpen, counting closures", () => {
    const plan = planIssueSync(
      [existing(1, "old"), existing(2, "keep")],
      [desired("keep"), desired("low", { priority: 1 }), desired("high", { priority: 9 }), desired("mid", { priority: 5 })],
      { ...options, maxOpen: 3 },
    );
    expect(plan.actions.map((action) => (action.type === "close" ? `close:${action.number}` : `${action.type}:${action.desired.fingerprint}`))).toEqual([
      "close:1",
      "create:high",
      "create:mid",
    ]);
    expect(plan.skipped).toEqual([{ fingerprint: "low", reason: "limit" }]);
  });
});
