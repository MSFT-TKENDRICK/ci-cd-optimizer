import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

test("startup authorizes one repository, preserves prior hooks and refuses malformed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cicd-startup-"));
  const script = join(root, "scripts", "agent-startup.mjs");
  const config = join(root, ".agent-artifacts", "ci-feedback.json");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined };
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, ".githooks"));
    await writeFile(join(root, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await mkdir(join(root, "plugins", "ci-cd-optimizer", "server"), { recursive: true });
    await copyFile(new URL("../../scripts/agent-startup.mjs", import.meta.url), script);
    await copyFile(new URL("../../scripts/install-hooks.mjs", import.meta.url), join(root, "scripts", "install-hooks.mjs"));
    await writeFile(join(root, "plugins", "ci-cd-optimizer", "server", "cicd-agents.mjs"), "");
    await writeFile(env.GIT_CONFIG_GLOBAL, "");
    git("init", "--quiet");
    assert.throws(() => run("--auth", "github-cli"), /explicit --repo/);
    const args = ["--repo", "acme/widgets", "--auth", "github-cli", "--install-hooks"];
    run(...args);
    assert.equal(git("config", "--get", "core.hooksPath"), ".githooks");
    const original = await readFile(config, "utf8");
    run(...args);
    assert.equal(await readFile(config, "utf8"), original);
    assert.throws(() => run("--repo", "another/repo", "--auth", "github-cli"), /authorization differs/);
    assert.equal(await readFile(config, "utf8"), original);
    git("config", "--local", "core.hooksPath", "existing-hooks");
    assert.throws(() => run(...args), /Existing Git hooks configuration was preserved/);
    assert.equal(git("config", "--get", "core.hooksPath"), "existing-hooks");
    git("config", "--local", "--unset", "core.hooksPath");
    await writeFile(join(root, ".git", "hooks", "pre-push"), "existing");
    assert.throws(() => run(...args), /existing pre-push hook was preserved/);
    await writeFile(config, '{"private-value": malformed');
    assert.throws(() => run(...args), (error) => {
      const message = error.stderr.toString();
      return message.includes("not valid JSON") && !message.includes("private-value");
    });
    assert.deepEqual(await readdir(join(root, ".agent-artifacts")), ["ci-feedback.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every independently triggered workflow is benchmarked without telemetry recursion", async () => {
  const directory = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const workflows = await Promise.all((await readdir(directory)).filter((file) => /\.ya?ml$/.test(file))
    .map(async (file) => parse(await readFile(join(directory, file), "utf8"))));
  const producer = workflows.find((workflow) => workflow.name === "CI/CD Optimizer telemetry");
  const expected = workflows.filter((workflow) => workflow !== producer &&
    Object.keys(workflow.on).some((trigger) => trigger !== "workflow_call")).map((workflow) => workflow.name);
  assert.deepEqual([...producer.on.workflow_run.workflows].sort(), expected.sort());
  assert.equal(new Set(producer.on.workflow_run.workflows).size, expected.length);
});
