import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/index.js";
import { CI_MODEL_MAX_BYTES, parseCiEnvironmentModel } from "../../src/experiments/plan.js";
import { checkCertificate, createCiPlanCertificate } from "../../src/formal/certificate.js";
import { canonicalJson, certificateDigest, object, parseStrictJson, type Json } from "../../src/formal/json.js";
import { readCommittedBlob, type SourceBlob } from "../../src/formal/source.js";
import { fakeClient } from "../experiments/fixtures.js";

const root = join(process.cwd(), ".proof-build", `ci-plan-certificate-${randomUUID()}`);
const modelText = readFileSync(new URL("./fixtures/ci-environment.json", import.meta.url), "utf8");
const impossible = { ...parseCiEnvironmentModel(modelText), horizonTicks: 1 };
let commit: string;
let source: SourceBlob;
let infeasibleSource: SourceBlob;
const git = (...args: string[]) => execFileSync("git", [
  "--no-pager", "-C", root, "-c", "core.autocrlf=false", "-c", `core.hooksPath=${join(root, "disabled-hooks")}`,
  "-c", "commit.gpgsign=false", "-c", "user.name=Proof Test", "-c", "user.email=proof@example.invalid", ...args,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const message = "Record CI model fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>";

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  git("init", "--initial-branch=main", "--quiet");
  await Promise.all([
    writeFile(join(root, "model.json"), modelText),
    writeFile(join(root, "impossible.json"), canonicalJson(impossible)),
  ]);
  git("add", "--all");
  git("commit", "--quiet", "-m", message);
  commit = git("rev-parse", "HEAD");
  source = await readCommittedBlob(root, commit, "model.json");
  infeasibleSource = await readCommittedBlob(root, commit, "impossible.json");
  await writeFile(join(root, "working-plan.json"), modelText);
}, 30_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function resign(value: Record<string, Json>): string {
  delete value.digest;
  value.digest = certificateDigest(value);
  return canonicalJson(value);
}
const result = (value: Record<string, Json>) => object(value.result, "result");
function firstJob(value: Record<string, Json>): Record<string, Json> {
  const schedule = result(value).schedule;
  if (!Array.isArray(schedule) || !schedule[0]) throw new Error("Missing test schedule.");
  return object(schedule[0], "first job");
}

describe("source-bound scheduling certificates", () => {
  it("recomputes the full modeled optimum from the committed model, not supplied candidates", async () => {
    const certificate = createCiPlanCertificate(source);
    expect(certificate.result).toMatchObject({
      status: "optimal", policyId: 130, objective: { makespanTicks: 3, costUnits: 3 },
      search: { requiredPolicies: 256, examinedPolicies: 256, complete: true },
    });
    const serialized = canonicalJson(certificate);
    expect(await checkCertificate(serialized)).toMatchObject({ status: "model-valid", kind: "ci-policy-plan", resultStatus: "optimal" });
    expect(await checkCertificate(serialized, root)).toMatchObject({ status: "source-bound-valid", resultStatus: "optimal" });
    expect(certificate.assumptions.join(" ")).toContain("No workflow-to-model mapping");
    expect(certificate.assumptions.join(" ")).toContain("does not prove correspondence to a workflow");
    expect(certificate).not.toHaveProperty("workflow");
  });

  const mutations: Array<[string, (value: Record<string, Json>) => void]> = [
    ["policy identifier", (value) => { result(value).policyId = 0; }],
    ["selected mode", (value) => { firstJob(value).mode = "fast"; }],
    ["start", (value) => { firstJob(value).startTick = 1; }],
    ["finish", (value) => { firstJob(value).finishTick = 1; }],
    ["resource usage", (value) => { result(value).runnerUsageByTick = [0]; }],
    ["makespan", (value) => { object(result(value).objective, "objective").makespanTicks = 1; }],
    ["cost", (value) => { object(result(value).objective, "objective").costUnits = 0; }],
    ["policy-space coverage", (value) => { object(result(value).search, "search").requiredPolicies = 1; }],
    ["examined count", (value) => { object(result(value).search, "search").examinedPolicies = 1; }],
    ["search completeness", (value) => { object(result(value).search, "search").complete = false; }],
    ["search request", (value) => { object(value.request, "request").searchBudget = 1; }],
    ["model digest", (value) => { result(value).modelSha256 = "0".repeat(64); }],
    ["proof metadata", (value) => { object(value.proof, "proof").modelsSha256 = "0".repeat(64); }],
    ["embedded proof metadata", (value) => { object(result(value).proof, "proof").modelsSha256 = "0".repeat(64); }],
    ["outcome", (value) => { result(value).status = "infeasible"; }],
    ["binding content", (value) => { object(value.source, "source").content = modelText + " "; }],
    ["assumptions", (value) => { value.assumptions = ["Every possible CI policy is optimal and faster."]; }],
    ["execution attestation", (value) => { result(value).authenticatedExecution = true; }],
    ["schema", (value) => { value.schema = "cicd-optimizer/certificate-v999"; }],
    ["promotion permission", (value) => { result(value).nextStep = "promote"; }],
  ];
  it.each(mutations)("rejects tampered %s even with a recomputed certificate digest", async (_name, mutate) => {
    const altered = object(parseStrictJson(canonicalJson(createCiPlanCertificate(source))), "certificate");
    mutate(altered);
    await expect(checkCertificate(resign(altered))).rejects.toThrow();
  });

  it("separates valid exhaustion and infeasibility evidence from an optimality claim", async () => {
    const exhausted = createCiPlanCertificate(source, 1);
    const infeasible = createCiPlanCertificate(infeasibleSource);
    expect(await checkCertificate(canonicalJson(exhausted), root)).toMatchObject({ status: "source-bound-valid", resultStatus: "budget-exhausted" });
    expect(await checkCertificate(canonicalJson(infeasible), root)).toMatchObject({ status: "source-bound-valid", resultStatus: "infeasible" });
    for (const certificate of [exhausted, infeasible]) {
      expect(certificate.result).not.toHaveProperty("objective");
      expect(certificate.result).not.toHaveProperty("schedule");
      const forged = object(parseStrictJson(canonicalJson(certificate)), "certificate");
      result(forged).status = "optimal";
      result(forged).objective = { makespanTicks: 0, costUnits: 0 };
      await expect(checkCertificate(resign(forged))).rejects.toThrow(/recomputation/);
    }
  });

  it("will not turn self-consistent invented input provenance into source binding", async () => {
    const bytes = Buffer.from(canonicalJson(impossible));
    const blob = createHash(source.blob.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const invented = createCiPlanCertificate({ ...source, blob, content: bytes.toString("utf8") });
    expect(await checkCertificate(canonicalJson(invented))).toMatchObject({ status: "model-valid", resultStatus: "infeasible" });
    await expect(checkCertificate(canonicalJson(invented), root)).rejects.toThrow(/Stale or forged/);
    const unknownCommit = createCiPlanCertificate({ ...source, commit: "0".repeat(commit.length) });
    expect(await checkCertificate(canonicalJson(unknownCommit))).toMatchObject({ status: "model-valid" });
    await expect(checkCertificate(canonicalJson(unknownCommit), root)).rejects.toThrow();
    const wrongPath = createCiPlanCertificate({ ...source, path: "impossible.json" });
    await expect(checkCertificate(canonicalJson(wrongPath), root)).rejects.toThrow(/Stale or forged/);
  });

  it("binds immutable commit bytes despite working changes and rejects stale commit assertions", async () => {
    const original = canonicalJson(createCiPlanCertificate(source));
    await writeFile(join(root, "model.json"), canonicalJson(impossible));
    expect(await checkCertificate(original, root)).toMatchObject({ status: "source-bound-valid", resultStatus: "optimal" });
    git("add", "--", "model.json");
    git("commit", "--quiet", "-m", message);
    const stale = createCiPlanCertificate({ ...source, commit: git("rev-parse", "HEAD") });
    await expect(checkCertificate(canonicalJson(stale), root)).rejects.toThrow(/Stale or forged/);
  }, 30_000);

  it("rejects duplicate JSON keys, malformed numerics and unrecognized model fields in certificates", async () => {
    const text = canonicalJson(createCiPlanCertificate(source));
    await expect(checkCertificate(text.replace('"searchBudget":50000', '"searchBudget":50000,"searchBudget":50000'))).rejects.toThrow(/Duplicate/);
    for (const number of ["1e999", "-0", "9007199254740993", "0.5"]) {
      await expect(checkCertificate(text.replace('"searchBudget":50000', `"searchBudget":${number}`))).rejects.toThrow();
    }
    const claimed = object(parseStrictJson(text), "certificate");
    object(claimed.request, "request").callerOptimal = true;
    await expect(checkCertificate(resign(claimed))).rejects.toThrow(/recomputation/);
  });
});

describe("modeled planning command contracts", () => {
  function io() {
    const output: string[] = [];
    const errors: string[] = [];
    const github = vi.fn(() => { throw new Error("Offline planning must not access GitHub."); });
    return { cwd: root, env: {}, github, output, errors, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
  }

  it("returns exact optimal, infeasible and exhausted codes without network or publication", async () => {
    for (const [extra, expectedCode, expectedStatus] of [
      [["--model", "working-plan.json"], 0, "optimal"],
      [["--model", "impossible.json"], 4, "infeasible"],
      [["--model", "working-plan.json", "--search-budget", "255"], 5, "budget-exhausted"],
    ] as const) {
      const capture = io();
      expect(await run(["experiments", "plan", ...extra], capture)).toBe(expectedCode);
      expect(JSON.parse(capture.output.join("\n"))).toMatchObject({ status: expectedStatus });
      expect(capture.github).not.toHaveBeenCalled();
      expect(capture.errors.join("\n")).not.toContain("permission to promote.");
    }
  });

  it("retains certificate-validity codes and reports each distinct model outcome", async () => {
    for (const [path, budget, outcome] of [
      ["model.json", "256", "optimal"], ["impossible.json", "256", "infeasible"], ["model.json", "1", "budget-exhausted"],
    ]) {
      const capture = io();
      const args = ["formal", "ci-plan", "--commit", commit, "--path", path!, "--search-budget", budget!, "--output", "plan-certificate.json"];
      expect(await run(args, capture)).toBe(0);
      expect(capture.errors.join("\n")).toContain(`Model outcome: ${outcome}`);
      expect(await run(["formal", "check", "plan-certificate.json"], capture)).toBe(3);
      expect(JSON.parse(capture.output.at(-1)!)).toMatchObject({ status: "model-valid", resultStatus: outcome });
      expect(await run(["formal", "check", "plan-certificate.json", "--source", "."], capture)).toBe(0);
      expect(JSON.parse(capture.output.at(-1)!)).toMatchObject({ status: "source-bound-valid", resultStatus: outcome });
      expect(capture.github).not.toHaveBeenCalled();
    }
  }, 30_000);

  it("rejects invalid input separately from usage and never silently adjusts a search budget", async () => {
    await writeFile(join(root, "invalid.json"), "{}");
    await writeFile(join(root, "invalid-utf8.json"), Buffer.from([0xff]));
    await writeFile(join(root, "oversize.json"), " ".repeat(CI_MODEL_MAX_BYTES + 1));
    for (const file of ["invalid.json", "invalid-utf8.json", "oversize.json", "missing.json", "."]) {
      expect(await run(["experiments", "plan", "--model", file], io())).toBe(1);
    }
    expect(await run(["experiments", "plan"], io())).toBe(2);
    for (const budget of ["0", "-1", "0.5", "250001", "001", "NaN", "1e2", "Infinity"]) {
      expect(await run(["experiments", "plan", "--model", "working-plan.json", "--search-budget", budget], io())).toBe(2);
    }
    expect(await run(["experiments", "plan", "--model", "working-plan.json", "--apply"], io())).toBe(2);
    expect(await run(["formal", "ci-plan", "--commit", "HEAD", "--path", "model.json"], io())).toBe(2);
  });

  it("writes a plan file and recomputes the plan through the real generator-context command", async () => {
    const capture = io();
    expect(await run(["experiments", "plan", "--model", "working-plan.json", "--output", "plan.json"], capture)).toBe(0);
    expect(JSON.parse(await readFile(join(root, "plan.json"), "utf8"))).toMatchObject({ status: "optimal", policyId: 130 });
    const client = fakeClient(() => []);
    expect(await run(["experiments", "context", "--repo", "acme/widgets", "--model", "working-plan.json", "--search-budget", "256"],
      { ...capture, github: () => client })).toBe(0);
    expect(capture.output.join("\n")).toContain('"policyId": 130');
    expect(capture.output.join("\n")).toContain("never as measured evidence or permission to promote");
  });
});
