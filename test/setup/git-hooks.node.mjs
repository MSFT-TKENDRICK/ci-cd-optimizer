import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("managed hooks install idempotently and preserve existing hooks and configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "cicd-hooks-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const run = () => execFileSync(process.execPath, ["scripts/install-hooks.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, ".githooks"));
    await writeFile(env.GIT_CONFIG_GLOBAL, "");
    await copyFile(new URL("../../scripts/install-hooks.mjs", import.meta.url), join(root, "scripts", "install-hooks.mjs"));
    for (const hook of ["pre-commit", "pre-push"]) await copyFile(new URL(`../../.githooks/${hook}`, import.meta.url), join(root, ".githooks", hook));
    git("init", "--quiet");
    // This also covers Git templates which omit the hooks directory.
    await rm(join(root, ".git", "hooks"), { recursive: true, force: true });
    run();
    run();
    assert.equal(git("config", "--get", "core.hooksPath"), ".githooks");
    git("config", "--local", "core.hooksPath", "custom");
    assert.throws(run, /configuration was preserved/);
    git("config", "--local", "--unset", "core.hooksPath");
    await mkdir(join(root, ".git", "hooks"));
    await writeFile(join(root, ".git", "hooks", "commit-msg"), "existing validation");
    assert.throws(run, /existing commit-msg hook was preserved/);
    assert.equal(await readFile(join(root, ".git", "hooks", "commit-msg"), "utf8"), "existing validation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real Git commit invokes secret, ESLint and optimizer gates, and each failure blocks it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cicd hook run-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined };
  const git = (...args) => spawnSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true });
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, "");
    for (const dir of ["scripts", ".githooks", ".gitleaks", "node_modules/eslint/bin", "node_modules/tsx/dist"]) await mkdir(join(root, dir), { recursive: true });
    await copyFile(new URL("../../scripts/run-git-hook.mjs", import.meta.url), join(root, "scripts", "run-git-hook.mjs"));
    await copyFile(new URL("../../scripts/install-hooks.mjs", import.meta.url), join(root, "scripts", "install-hooks.mjs"));
    await writeFile(join(root, "package.json"), '{"type":"module","scripts":{"ci:check-generated":"node generated-check.cjs"}}');
    await writeFile(join(root, "generated-check.cjs"), "require('node:fs').appendFileSync('gates.log', '3'); if (process.env.FAIL_GENERATED) process.exit(1);");
    for (const name of ["pre-commit", "pre-push"]) {
      await copyFile(new URL(`../../.githooks/${name}`, import.meta.url), join(root, ".githooks", name));
      await chmod(join(root, ".githooks", name), 0o755);
    }
    const checks = [".gitleaks/better-gitleaks", "node_modules/eslint/bin/eslint.js", "node_modules/tsx/dist/cli.mjs"];
    for (const [index, path] of checks.entries()) {
      await writeFile(join(root, path), `import { appendFileSync } from 'node:fs'; appendFileSync('gates.log', '${index}'); if (process.env.FAIL_GATE === '${index}') process.exit(1);`, "utf8");
    }
    await writeFile(join(root, "node_modules", "eslint", "package.json"), '{"type":"module"}');
    assert.equal(git("init", "--quiet").status, 0);
    execFileSync(process.execPath, ["scripts/install-hooks.mjs"], { cwd: root, env });
    await writeFile(join(root, "file.txt"), "safe fixture");
    assert.equal(git("add", "file.txt").status, 0);
    const commit = () => git("-c", "user.name=Hook test", "-c", "user.email=hooks@example.invalid", "commit", "--quiet", "-m", "Hook fixture");
    for (let index = 0; index < checks.length; index += 1) {
      env.FAIL_GATE = String(index);
      await writeFile(join(root, "gates.log"), "");
      assert.notEqual(commit().status, 0);
      assert.equal(await readFile(join(root, "gates.log"), "utf8"), "012".slice(0, index + 1));
    }
    delete env.FAIL_GATE;
    await writeFile(join(root, "gates.log"), "");
    assert.equal(commit().status, 0);
    assert.equal(await readFile(join(root, "gates.log"), "utf8"), "012");
    const push = () => spawnSync(process.execPath, ["scripts/run-git-hook.mjs", "pre-push"], { cwd: root, env, encoding: "utf8" });
    await writeFile(join(root, "gates.log"), "");
    assert.equal(push().status, 0);
    assert.equal(await readFile(join(root, "gates.log"), "utf8"), "03");
    env.FAIL_GENERATED = "1";
    assert.notEqual(push().status, 0, "the existing generated-output push gate must remain mandatory");
    delete env.FAIL_GENERATED;
    await rm(join(root, checks[0]));
    assert.notEqual(git("commit", "--allow-empty", "-m", "Missing scanner").status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
