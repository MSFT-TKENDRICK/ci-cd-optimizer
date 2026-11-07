import { describe, expect, it } from "vitest";
import { CONSENT_MAX_BYTES, CONSENT_PATH, parseConsentText, readCappedFile, verifyConsent } from "../../src/review/consent.js";
import { REVIEW_CONCURRENCY, reviewProject } from "../../src/review/review.js";
import { fakeClient } from "../experiments/fixtures.js";
import { CONSENT_YAML, PROJECT_YAML, project, REGISTRY_NAME, STRICT_PROJECT_YAML, TARGET, TARGET_ID, TARGET_SHA, TREE_SHA, world } from "./fixtures.js";

const verify = (spec: Parameters<typeof world>[0] = {}, author?: string, text = PROJECT_YAML) =>
  verifyConsent(world(spec), project(text), { registry: REGISTRY_NAME, ...(author !== undefined ? { author } : {}) });

describe("parseConsentText", () => {
  it("accepts a minimal consent file", () => {
    expect(parseConsentText(CONSENT_YAML)).toEqual({
      consent: { registry: REGISTRY_NAME, project: "widget", contacts: ["octocat", "hubot"] },
      problems: [],
    });
  });

  it.each([
    ["unknown key", `${CONSENT_YAML}extra: 1\n`, "has unknown key"],
    ["bad registry", "registry: not a repo\nproject: widget\ncontacts: [octocat]\n", "registry must be"],
    ["missing project", "registry: a/b\ncontacts: [octocat]\n", "project must be"],
    ["empty contacts", "registry: a/b\nproject: widget\ncontacts: []\n", "contacts must be a list of 1-50"],
    ["non-login contact", "registry: a/b\nproject: widget\ncontacts: ['@octocat']\n", "contacts must be a list"],
    ["too many contacts", `registry: a/b\nproject: widget\ncontacts: [${Array.from({ length: 51 }, (_, i) => `u${i}`).join(", ")}]\n`, "contacts must be a list"],
    ["duplicate contacts", "registry: a/b\nproject: widget\ncontacts: [octocat, OctoCat]\n", "must not contain duplicates"],
    ["alias", "registry: &r a/b\nproject: *r\ncontacts: [octocat]\n", "alias"],
    ["oversize", `# ${"x".repeat(CONSENT_MAX_BYTES)}\n${CONSENT_YAML}`, `${CONSENT_MAX_BYTES} bytes`],
  ])("rejects %s", (_label, text, expected) => {
    const result = parseConsentText(text);
    expect(result.consent).toBeUndefined();
    expect(result.problems.join("\n")).toContain(expected);
  });
});

describe("readCappedFile", () => {
  it("refuses directories, oversize files and non-base64 encodings", async () => {
    const client = (data: unknown) => fakeClient(() => data);
    await expect(readCappedFile(client([]), TARGET, "x", TARGET_SHA, 10)).resolves.toMatchObject({ kind: "rejected" });
    await expect(readCappedFile(client({ type: "symlink" }), TARGET, "x", TARGET_SHA, 10)).resolves.toMatchObject({ kind: "rejected" });
    await expect(readCappedFile(client({ type: "file", size: 11, encoding: "base64", content: "" }), TARGET, "x", TARGET_SHA, 10)).resolves.toMatchObject({
      kind: "rejected",
      reason: "x is larger than 10 bytes.",
    });
    // The declared size lies; the decoded content is still capped.
    const lying = { type: "file", size: 1, encoding: "base64", content: Buffer.from("y".repeat(11)).toString("base64") };
    await expect(readCappedFile(client(lying), TARGET, "x", TARGET_SHA, 10)).resolves.toMatchObject({ kind: "rejected" });
    await expect(readCappedFile(client({ type: "file", size: 1, encoding: "none", content: "" }), TARGET, "x", TARGET_SHA, 10)).resolves.toMatchObject({ kind: "rejected" });
  });
});

describe("verifyConsent", () => {
  it("passes for a consenting public repository and pins the default-branch SHA", async () => {
    const client = world();
    const result = await verifyConsent(client, project(), { registry: REGISTRY_NAME, author: "OctoCat" });
    expect(result).toEqual({
      ok: true,
      problems: [],
      repository: { id: TARGET_ID, fullName: "octo-org/widget", owner: "octo-org", repo: "widget", defaultBranch: "main", sha: TARGET_SHA, treeSha: TREE_SHA },
    });
    const consentRead = client.calls.find((call) => call.parameters.path === CONSENT_PATH);
    expect(consentRead?.parameters).toMatchObject({ owner: "octo-org", repo: "widget", ref: TARGET_SHA });
    expect(client.calls[0]).toMatchObject({ route: "GET /repositories/{repository_id}", parameters: { repository_id: TARGET_ID } });
    expect(client.calls.some((call) => call.route.includes("collaborators"))).toBe(false);
  });

  it("matches the registry case-insensitively", async () => {
    const result = await verify({ consent: CONSENT_YAML.replace("MSFT-TKENDRICK/ci-cd-optimizer", "msft-tkendrick/CI-CD-optimizer") });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["the submitter is not a contact", {}, "mallory", "Submitter \"mallory\" is not listed"],
    ["auto_ccs are not contacts", { consent: CONSENT_YAML.replace("[octocat, hubot]", "[octocat]") }, undefined, "auto_ccs entry \"hubot\" is not listed"],
    ["the primary contact is not a contact", { consent: CONSENT_YAML.replace("[octocat, hubot]", "[hubot]") }, undefined, "primary_contact \"octocat\" is not listed"],
    ["the registry differs", { consent: CONSENT_YAML.replace("MSFT-TKENDRICK/ci-cd-optimizer", "evil/registry") }, undefined, 'registry is "evil/registry"; expected'],
    ["the project differs", { consent: CONSENT_YAML.replace("project: widget", "project: gadget") }, undefined, 'project is "gadget"; expected "widget"'],
    ["the consent file is missing", { consent: undefined }, undefined, "was not found on the default branch"],
    ["the consent file is invalid", { consent: "registry: [\n" }, undefined, "is not valid YAML"],
  ])("fails when %s", async (_label, spec, author, expected) => {
    const result = await verify(spec, author);
    expect(result.ok).toBe(false);
    expect(result.repository?.sha).toBe(TARGET_SHA);
    expect(result.problems.join("\n")).toContain(expected);
  });

  it.each([
    ["the id resolves elsewhere", { id: 1 }, "did not resolve to the same repository"],
    ["the repository was renamed or transferred", { full_name: "someone-else/widget" }, "update main_repo in a new pull request"],
    ["the repository is private", { private: true, visibility: "private" }, "must be public"],
    ["the repository is internal", { visibility: "internal" }, "must be public"],
    ["privacy is unknown", { private: undefined }, "must be public"],
    ["the repository is a fork", { fork: true }, "must not be a fork"],
    ["the repository is archived", { archived: true }, "is archived"],
    ["the repository is disabled", { disabled: true }, "is disabled"],
    ["there is no default branch", { default_branch: null }, "has no default branch"],
  ])("fails before reading any file when %s", async (_label, metadata, expected) => {
    const client = world({ metadata });
    const result = await verifyConsent(client, project(), { registry: REGISTRY_NAME });
    expect(result.ok).toBe(false);
    expect(result.repository).toBeUndefined();
    expect(result.problems.join("\n")).toContain(expected);
    expect(client.calls.map((call) => call.route)).toEqual(["GET /repositories/{repository_id}"]);
  });

  it("reports a missing repository id without leaking API errors", async () => {
    const result = await verify({ metadata: "missing" });
    expect(result).toEqual({ ok: false, problems: [`Repository id ${TARGET_ID} was not found or is not public.`] });
  });
});

describe("reviewProject", () => {
  it("lints the pinned default-branch tree through the API", async () => {
    const client = world();
    const outcome = await reviewProject(client, project(STRICT_PROJECT_YAML), { registry: REGISTRY_NAME, author: "octocat" });
    expect(outcome.status).toBe("ok");
    expect(outcome.repository?.sha).toBe(TARGET_SHA);
    expect(outcome.filesAnalyzed).toBeGreaterThan(0);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain("hermeticity/pin-actions");
    const refs = client.calls.filter((call) => call.route.includes("/contents/")).map((call) => call.parameters.ref);
    expect(new Set(refs)).toEqual(new Set([TARGET_SHA]));
    expect(REVIEW_CONCURRENCY).toBe(4);
  });

  it("honors the target configuration's suppressions", async () => {
    const config = "rules:\n  hermeticity/pin-actions: off\n";
    const outcome = await reviewProject(world({ config }), project(STRICT_PROJECT_YAML), { registry: REGISTRY_NAME });
    expect(outcome.status).toBe("ok");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.ruleId)).not.toContain("hermeticity/pin-actions");
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
  });

  it("lets the project preset replace the target's extends", async () => {
    const config = "extends: [strict]\n";
    const outcome = await reviewProject(world({ config }), project(), { registry: REGISTRY_NAME });
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain("hermeticity/pin-actions");
    const recommended = await reviewProject(world({ config }), project(`${PROJECT_YAML}preset: recommended\n`), { registry: REGISTRY_NAME });
    expect(recommended.diagnostics.map((diagnostic) => diagnostic.ruleId)).not.toContain("hermeticity/pin-actions");
  });

  it("stops when the target disables the linter", async () => {
    const outcome = await reviewProject(world({ config: "enabled: false\n" }), project(), { registry: REGISTRY_NAME });
    expect(outcome.status).toBe("ok");
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.notes.join("\n")).toContain("sets enabled: false, so no rules ran");
  });

  it("does not touch the network for a paused project", async () => {
    const client = world();
    const outcome = await reviewProject(client, project(`${PROJECT_YAML}paused: true\n`), { registry: REGISTRY_NAME });
    expect(outcome.status).toBe("paused");
    expect(outcome.notes.join("\n")).toContain("Reviews are paused");
    expect(client.calls).toEqual([]);
  });

  it("reports consent failures without linting", async () => {
    const client = world({ consent: undefined });
    const outcome = await reviewProject(client, project(), { registry: REGISTRY_NAME });
    expect(outcome.status).toBe("consent-failed");
    expect(outcome.diagnostics).toEqual([]);
    expect(client.calls.some((call) => call.route.includes("/git/trees/"))).toBe(false);
  });

  it("turns unexpected API failures into an error status with a sanitized message", async () => {
    const outcome = await reviewProject(world({ commitError: new Error("boom\u202e @admin\nmore") }), project(), { registry: REGISTRY_NAME });
    expect(outcome.status).toBe("error");
    expect(outcome.problems[0]).toMatch(/^The review could not complete: boom/);
    expect(outcome.problems[0]).not.toMatch(/[\u202e\n]/);
  });
});
