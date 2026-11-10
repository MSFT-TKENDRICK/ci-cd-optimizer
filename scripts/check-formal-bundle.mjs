import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, ".proof-build", "bundle-certificate.json");
const invalid = resolve(root, ".proof-build", "bundle-forged-certificate.json");
const planOutput = resolve(root, ".proof-build", "bundle-plan-certificate.json");
const impossible = resolve(root, ".proof-build", "bundle-infeasible-model.json");
const modelPath = "test/formal/fixtures/ci-environment.json";
const commit = execFileSync("git", ["--no-pager", "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const command = (...args) => spawnSync(process.execPath, [resolve(root, "dist-action", "index.js"), ...args], { cwd: root, encoding: "utf8", timeout: 120_000 });
const invoke = (...args) => command("formal", ...args);
const success = (result, code) => assert.equal(result.status, code, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const resign = (value) => {
  delete value.digest;
  value.digest = createHash("sha256").update(`cicd-optimizer/cert-v1\0${canonical(value)}`).digest("hex");
  return canonical(value);
};
await mkdir(resolve(root, ".proof-build"), { recursive: true });
try {
  success(invoke("cache-key", "--commit", commit, "--path", "test/formal/fixtures/cache-workflow.yml", "--job", "build", "--step", "0", "--output", output), 0);
  const certificate = JSON.parse(await readFile(output, "utf8"));
  assert.equal(certificate.result.undetermined.length, 1);
  assert.equal(certificate.result.undetermined[0].varied, "github.sha");
  assert.equal(certificate.result.recommendation.exactPartition, true);
  const sourceBound = invoke("check", output, "--source", root);
  success(sourceBound, 0);
  assert.equal(JSON.parse(sourceBound.stdout).status, "source-bound-valid");
  const modelOnly = invoke("check", output);
  success(modelOnly, 3);
  assert.equal(JSON.parse(modelOnly.stdout).status, "model-valid");
  certificate.result.undetermined[0].dependenciesEqual = false;
  await writeFile(invalid, resign(certificate));
  success(invoke("check", invalid, "--source", root), 1);

  const planned = command("experiments", "plan", "--model", modelPath);
  success(planned, 0);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.status, "optimal");
  assert.equal(plan.policyId, 130);
  assert.deepEqual(plan.objective, { makespanTicks: 3, costUnits: 3 });
  assert.deepEqual(plan.schedule.map(({ mode, startTick, finishTick }) => ({ mode, startTick, finishTick })), [
    { mode: "slow", startTick: 0, finishTick: 2 },
    { mode: "fast", startTick: 2, finishTick: 3 },
  ]);
  assert.equal(plan.search.requiredPolicies, 256);
  assert.equal(plan.search.examinedPolicies, 256);
  assert.equal(plan.search.complete, true);

  const exhausted = command("experiments", "plan", "--model", modelPath, "--search-budget", "255");
  success(exhausted, 5);
  const exhaustion = JSON.parse(exhausted.stdout);
  assert.equal(exhaustion.status, "budget-exhausted");
  assert.equal(exhaustion.search.examinedPolicies, 0);
  assert.equal(exhaustion.search.complete, false);
  assert.equal(Object.hasOwn(exhaustion, "objective"), false);
  assert.equal(Object.hasOwn(exhaustion, "schedule"), false);
  const impossibleModel = JSON.parse(await readFile(resolve(root, modelPath), "utf8"));
  impossibleModel.horizonTicks = 1;
  await writeFile(impossible, JSON.stringify(impossibleModel));
  const infeasible = command("experiments", "plan", "--model", impossible);
  success(infeasible, 4);
  assert.equal(JSON.parse(infeasible.stdout).status, "infeasible");

  success(invoke("ci-plan", "--commit", commit, "--path", modelPath, "--output", planOutput), 0);
  const planSourceBound = invoke("check", planOutput, "--source", root);
  success(planSourceBound, 0);
  assert.equal(JSON.parse(planSourceBound.stdout).resultStatus, "optimal");
  const planModelOnly = invoke("check", planOutput);
  success(planModelOnly, 3);
  assert.equal(JSON.parse(planModelOnly.stdout).resultStatus, "optimal");
  const forgedPlan = JSON.parse(await readFile(planOutput, "utf8"));
  forgedPlan.result.objective.makespanTicks = 1;
  await writeFile(invalid, resign(forgedPlan));
  success(invoke("check", invalid, "--source", root), 1);
  success(invoke("ci-plan", "--commit", commit, "--path", modelPath, "--search-budget", "1", "--output", planOutput), 0);
  const exhaustedCertificate = invoke("check", planOutput, "--source", root);
  success(exhaustedCertificate, 0);
  assert.deepEqual(
    { status: JSON.parse(exhaustedCertificate.stdout).status, resultStatus: JSON.parse(exhaustedCertificate.stdout).resultStatus },
    { status: "source-bound-valid", resultStatus: "budget-exhausted" },
  );
  console.log("Shipped Action executes verified cache and complete scheduling kernels, preserves outcome/validity distinctions, and rejects rehashed tampering.");
} finally {
  await Promise.all([output, invalid, planOutput, impossible].map((path) => rm(path, { force: true })));
}
