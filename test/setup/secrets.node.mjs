import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const name = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
let scanner;
try { scanner = await readFile(new URL(`../../.gitleaks/bin/${name}`, import.meta.url)); }
catch (error) { if (error.code !== "ENOENT") throw error; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cicd-secrets-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined };
  await writeFile(env.GIT_CONFIG_GLOBAL, "");
  for (const dir of ["scripts", ".gitleaks/bin"]) await mkdir(join(root, dir), { recursive: true });
  await copyFile(new URL("../../scripts/check-secrets.mjs", import.meta.url), join(root, "scripts", "check-secrets.mjs"));
  await copyFile(new URL("../../.gitleaks/better-gitleaks", import.meta.url), join(root, ".gitleaks", "better-gitleaks"));
  await copyFile(new URL("../../.gitleaks/toolchain.json", import.meta.url), join(root, ".gitleaks", "toolchain.json"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  const scan = (mode = "staged") => spawnSync(process.execPath, [".gitleaks/better-gitleaks", mode], { cwd: root, env, encoding: "utf8", windowsHide: true });
  return { root, env, git, scan };
}

test("secret gate fails closed when the pinned scanner is missing or arguments are invalid", async () => {
  const { root, scan } = await fixture();
  try {
    const result = scan();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secret checks cannot be skipped/);
    assert.match(scan("--exit-code=0").stderr, /Usage:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real pinned scanner reads staged bytes, redacts findings and ignores ambient/inline bypasses", { skip: !scanner }, async () => {
  const { root, env, git, scan } = await fixture();
  try {
    await writeFile(join(root, ".gitleaks", "bin", name), scanner);
    await chmod(join(root, ".gitleaks", "bin", name), 0o755);
    // A detector-specific synthetic marker exercises the scanner without storing a real credential.
    const marker = ["cicd", "synthetic", "fixture", "value"].join("-");
    await writeFile(join(root, ".gitleaks", "config.toml"), `[[rules]]\nid = "fixture"\ndescription = "Synthetic regression detector"\nregex = '''${marker}'''\n`);
    env.GITLEAKS_CONFIG_TOML = 'title = "disabled"';
    await writeFile(join(root, "data.txt"), `${marker} # gitleaks:allow\n`);
    git("add", "data.txt");
    await writeFile(join(root, "data.txt"), "safe working tree\n");
    const finding = scan();
    assert.notEqual(finding.status, 0);
    assert.match(finding.stdout + finding.stderr, /REDACTED/);
    assert.ok(!(finding.stdout + finding.stderr).includes(marker));
    git("add", "data.txt");
    await writeFile(join(root, "data.txt"), marker);
    assert.equal(scan().status, 0, "unstaged bytes must not replace the index scan");
    await rm(join(root, "data.txt"));
    git("rm", "--cached", "data.txt");
    assert.equal(scan().status, 0, "an empty index must not skip the scanner or fail");
  } finally { await rm(root, { recursive: true, force: true }); }
});
