import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, ".proof-build", "bundle-certificate.json");
const invalid = resolve(root, ".proof-build", "bundle-forged-certificate.json");
const commit = execFileSync("git", ["--no-pager", "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const invoke = (...args) => spawnSync(process.execPath, [resolve(root, "dist-action", "index.js"), "formal", ...args], { cwd: root, encoding: "utf8" });
const success = (result, code) => assert.equal(result.status, code, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
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
  await writeFile(invalid, JSON.stringify(certificate));
  success(invoke("check", invalid, "--source", root), 1);
  console.log("Shipped Action executes the generated cache checker, distinguishes source/model validity, and rejects tampering.");
} finally {
  await Promise.all([output, invalid].map((path) => rm(path, { force: true })));
}
