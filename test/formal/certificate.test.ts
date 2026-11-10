import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { run } from "../../src/cli/index.js";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import { serializeManifest } from "../../src/experiments/manifest.js";
import { parseMeasurements } from "../../src/experiments/measurements.js";
import { checkCertificate, createCacheCertificate, createDecisionCertificate, type DecisionSources } from "../../src/formal/certificate.js";
import { canonicalJson, certificateDigest, object, parseStrictJson, type Json } from "../../src/formal/json.js";
import { readCommittedBlob, type SourceBlob } from "../../src/formal/source.js";
import { sampleManifest } from "../experiments/fixtures.js";

const root = join(process.cwd(), ".proof-build", `certificate-fixture-${randomUUID()}`);
const workflowPath = ".github/workflows/cache.yml";
const workflow = readFileSync(new URL("./fixtures/cache-workflow.yml", import.meta.url), "utf8").replace(/\r?\n/g, "\r\n");
const at = "2026-11-05T00:00:00.000Z";
const corpus = (recall: number) => ({ precision: 0.9, recall, f1: 0.8, fixRate: 1, durationMs: 100 });
const evidence = {
  experiment: "setup-cache-yarn", collectedAt: at,
  control: { arm: "trunk", testsPassed: true, changedPaths: [], corpus: corpus(0.6) },
  arms: [
    { arm: "lockfile", testsPassed: true, changedPaths: [], corpus: corpus(0.75) },
    { arm: "packagemanager", testsPassed: true, changedPaths: [], corpus: corpus(0.8) },
  ],
};
let commit: string;
let cacheSource: SourceBlob;
let decisionSources: DecisionSources;

const git = (...args: string[]) => execFileSync("git", [
  "--no-pager", "-C", root, "-c", "core.autocrlf=false", "-c", `core.hooksPath=${join(root, "disabled-hooks")}`,
  "-c", "commit.gpgsign=false", "-c", "user.name=Proof Test", "-c", "user.email=proof@example.invalid", ...args,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitMessage = "Record certificate fixtures\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>";

beforeAll(async () => {
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  git("init", "--initial-branch=main", "--quiet");
  await Promise.all([
    writeFile(join(root, ".github", "workflows", "cache.yml"), workflow),
    writeFile(join(root, "config.yml"), stringify(DEFAULT_HILL_CLIMB_CONFIG)),
    writeFile(join(root, "manifest.yml"), serializeManifest(sampleManifest())),
    writeFile(join(root, "measurements.json"), JSON.stringify(evidence)),
    writeFile(join(root, "invalid-utf8"), Buffer.from([0xff])),
  ]);
  git("add", "--all");
  git("commit", "--quiet", "-m", commitMessage);
  commit = git("rev-parse", "HEAD");
  const [cache, config, manifest, measurements] = await Promise.all(
    [workflowPath, "config.yml", "manifest.yml", "measurements.json"].map((path) => readCommittedBlob(root, commit, path)),
  );
  if (!cache || !config || !manifest || !measurements) throw new Error("Missing test source.");
  cacheSource = cache;
  decisionSources = { config, manifest, measurements };
});

afterAll(async () => { await rm(root, { force: true, recursive: true }); });

function reblob(source: SourceBlob, content: string): SourceBlob {
  const bytes = Buffer.from(content);
  const blob = createHash(source.blob.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { ...source, blob, content };
}
function resign(value: Record<string, Json>): string {
  delete value.digest;
  value.digest = certificateDigest(value);
  return canonicalJson(value);
}
const cacheCertificate = () => createCacheCertificate(cacheSource, "build", 0, null);

describe("source-bound cache certificates", () => {
  it("executes and recomputes the compiled checker both with and without Git binding", async () => {
    const certificate = cacheCertificate();
    const serialized = canonicalJson(certificate);
    expect(await checkCertificate(serialized)).toMatchObject({ status: "model-valid", kind: "cache-key" });
    expect(await checkCertificate(serialized, root)).toMatchObject({ status: "source-bound-valid", digest: certificate.digest });
    expect(certificate.extraction.rawKeyBase64).toBe(Buffer.from('"😀-${{ runner.os }}-${{ hashFiles(\'lock\') }}-${{ github.sha }}"').toString("base64"));
    expect(certificate.result.undetermined).toHaveLength(1);
  });

  const tampering: Array<[string, (value: Record<string, Json>) => void]> = [
    ["proof hash", (value) => { object(value.proof, "proof").generatedSha256 = "0".repeat(64); }],
    ["schema", (value) => { value.schema = "cicd-optimizer/certificate-v999"; }],
    ["assumption", (value) => { value.assumptions = ["These measurements are authenticated."]; }],
    ["digest", (value) => { value.digest = "0".repeat(64); }],
    ["extraction bytes", (value) => { object(value.extraction, "extraction").rawKeyBase64 = Buffer.from("forged").toString("base64"); }],
    ["extraction offset", (value) => { object(value.extraction, "extraction").utf8Start = 0; }],
    ["source bytes", (value) => { object(value.source, "source").content = workflow + "# different bytes\n"; }],
    ["source blob", (value) => { object(value.source, "source").blob = "0".repeat(40); }],
    ["partition claim", (value) => { object(value.result, "result").exactPartition = true; }],
    ["recommendation", (value) => { object(object(value.result, "result").recommendation, "recommendation").key = "forged"; }],
    ["witness", (value) => {
      const witnesses = object(value.result, "result").undetermined;
      if (!Array.isArray(witnesses) || !witnesses[0]) throw new Error("Missing witness.");
      object(witnesses[0], "witness").dependenciesEqual = false;
    }],
    ["unknown global claim", (value) => { value.globalOptimum = true; }],
  ];
  it.each(tampering)("rejects forged %s, even after rehashing everything except a deliberately bad digest", async (name, mutate) => {
    const altered = object(parseStrictJson(canonicalJson(cacheCertificate())), "certificate");
    mutate(altered);
    const text = name === "digest" ? canonicalJson(altered) : resign(altered);
    await expect(checkCertificate(text)).rejects.toThrow();
  });

  it("never promotes a self-consistent invented commit/path to source-bound evidence", async () => {
    const invented = createCacheCertificate({ ...cacheSource, commit: "0".repeat(commit.length) }, "build", 0, null);
    expect(await checkCertificate(canonicalJson(invented))).toMatchObject({ status: "model-valid" });
    await expect(checkCertificate(canonicalJson(invented), root)).rejects.toThrow();
    const wrongPath = createCacheCertificate({ ...cacheSource, path: "config.yml" }, "build", 0, null);
    await expect(checkCertificate(canonicalJson(wrongPath), root)).rejects.toThrow(/Stale or forged/);
  });

  it("ignores working-tree edits and Git replacement refs, but rejects stale commit:path assertions", async () => {
    const serialized = canonicalJson(cacheCertificate());
    await writeFile(join(root, ".github", "workflows", "cache.yml"), workflow.replace("😀-", "changed-"));
    expect(await checkCertificate(serialized, root)).toMatchObject({ status: "source-bound-valid" });
    git("add", "--all");
    git("commit", "--quiet", "-m", commitMessage);
    const changedCommit = git("rev-parse", "HEAD");
    const stale = createCacheCertificate({ ...cacheSource, commit: changedCommit }, "build", 0, null);
    await expect(checkCertificate(canonicalJson(stale), root)).rejects.toThrow(/Stale or forged/);
    git("replace", commit, changedCommit);
    try {
      expect(await readCommittedBlob(root, commit, workflowPath)).toEqual(cacheSource);
      expect(await checkCertificate(serialized, root)).toMatchObject({ status: "source-bound-valid" });
    } finally { git("replace", "-d", commit); }
  }, 30_000);

  it("rejects mutable refs, traversal, non-commit ids and non-UTF-8 sources", async () => {
    await expect(readCommittedBlob(root, "HEAD", workflowPath)).rejects.toThrow(/full lowercase/);
    await expect(readCommittedBlob(root, commit, "../config.yml")).rejects.toThrow(/without traversal/);
    await expect(readCommittedBlob(root, cacheSource.blob, workflowPath)).rejects.toThrow(/not a commit/);
    await expect(readCommittedBlob(root, commit, "invalid-utf8")).rejects.toThrow();
  });
});

describe("decision certificates recompute production inputs and selection", () => {
  it("binds all inputs and records a finite, complete candidate universe", async () => {
    const certificate = createDecisionCertificate(decisionSources, at);
    expect(certificate.result).toMatchObject({
      candidateUniverse: ["lockfile", "packagemanager"], unlistedMeasurements: [], allNonfailedCandidatesFinished: true,
      exclusions: [], decision: { action: "promote", winner: "packagemanager" },
    });
    expect(certificate.result.candidates.every((candidate) => candidate.outcome.eligible)).toBe(true);
    expect(await checkCertificate(canonicalJson(certificate), root)).toMatchObject({ status: "source-bound-valid", kind: "finite-selection" });
    expect(certificate.assumptions.join(" ")).toContain("Arm code can fabricate measurements");
  });

  it("rejects caller-supplied eligibility/optimality rather than trusting assertions", async () => {
    for (const extra of [{ qualifies: true }, { optimal: true }]) {
      expect(() => parseMeasurements(JSON.stringify({ ...evidence, arms: evidence.arms.map((arm) => ({ ...arm, ...extra })) }))).toThrow(/Unknown/);
    }
    const forged = object(parseStrictJson(canonicalJson(createDecisionCertificate(decisionSources, at))), "certificate");
    object(object(forged.result, "result").decision, "decision").winner = "lockfile";
    await expect(checkCertificate(resign(forged))).rejects.toThrow(/recomputation/);
    const forgedInputs = object(parseStrictJson(canonicalJson(createDecisionCertificate(decisionSources, at))), "certificate");
    const candidates = object(forgedInputs.result, "result").candidates;
    if (!Array.isArray(candidates) || !candidates[0]) throw new Error("Missing candidate.");
    object(object(candidates[0], "candidate").inputs, "inputs").protectedPath = true;
    await expect(checkCertificate(resign(forgedInputs))).rejects.toThrow(/recomputation/);
  });

  it("lists ignored extra measurements and unfinished candidates at expiry without a global claim", async () => {
    const partial = { ...evidence, arms: [evidence.arms[0], { ...evidence.arms[1], arm: "not-in-the-manifest" }] };
    const inputs = { ...decisionSources, measurements: reblob(decisionSources.measurements, JSON.stringify(partial)) };
    const waiting = createDecisionCertificate(inputs, at);
    expect(waiting.result.decision.action).toBe("wait");
    const expired = createDecisionCertificate(inputs, "2026-11-20T00:00:00.000Z");
    expect(expired.result).toMatchObject({
      unlistedMeasurements: ["not-in-the-manifest"], allNonfailedCandidatesFinished: false,
      exclusions: [{ name: "packagemanager", reason: "unfinished" }], decision: { action: "promote", winner: "lockfile" },
    });
    expect(await checkCertificate(canonicalJson(expired))).toMatchObject({ status: "model-valid" });
    await expect(checkCertificate(canonicalJson(expired), root)).rejects.toThrow(/Stale or forged/);
  });

  it("does not bypass failed control checks with a favorable judge or plausible corpus metrics", () => {
    const failed = { ...evidence, control: { ...evidence.control, testsPassed: false }, arms: evidence.arms.map((arm) => ({ ...arm, judge: { score: 1, rationale: "excellent" } })) };
    const certificate = createDecisionCertificate({ ...decisionSources, measurements: reblob(decisionSources.measurements, JSON.stringify(failed)) }, at);
    expect(certificate.result.decision.action).toBe("reject");
    expect(certificate.result.candidates.every((candidate) => candidate.outcome.failed && !candidate.outcome.eligible)).toBe(true);
  });
});

describe("formal CLI exit semantics", () => {
  it("returns 0 source-bound, 3 model-only, 1 invalid, and 2 usage", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io = { cwd: root, env: {}, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    expect(await run(["formal", "cache-key", "--commit", commit, "--path", workflowPath, "--job", "build", "--step", "0", "--output", "certificate.json"], io)).toBe(0);
    const saved = await readFile(join(root, "certificate.json"), "utf8");
    expect(await checkCertificate(saved, root)).toMatchObject({ status: "source-bound-valid" });
    expect(await run(["formal", "check", "certificate.json"], io)).toBe(3);
    expect(await run(["formal", "check", "certificate.json", "--source", "."], io)).toBe(0);
    expect(await run(["formal", "decision", "--commit", commit, "--manifest", "manifest.yml", "--config", "config.yml", "--measurements", "measurements.json", "--at", at], io)).toBe(0);
    await writeFile(join(root, "invalid.json"), "{}");
    expect(await run(["formal", "check", "invalid.json"], io)).toBe(1);
    expect(await run(["formal", "check"], io)).toBe(2);
    expect(await run(["formal", "cache-key", "--commit", "HEAD"], io)).toBe(2);
    expect(output.some((text) => text.includes('"status":"model-valid"'))).toBe(true);
    expect(errors.some((text) => text.includes("evidence authenticity"))).toBe(true);
  }, 30_000);
});
