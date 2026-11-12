import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (!["staged", "history"].includes(mode) || process.argv.length !== 3) throw new Error("Usage: node .gitleaks/better-gitleaks staged|history");
const lock = JSON.parse(await readFile(join(root, ".gitleaks", "toolchain.json"), "utf8"));
const binary = join(root, ".gitleaks", "bin", process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
let version;
try { version = execFileSync(binary, ["version"], { encoding: "utf8", windowsHide: true }).trim(); }
catch { throw new Error("Pinned Gitleaks is unavailable. Run npm run secrets:install; secret checks cannot be skipped."); }
if (version !== lock.version) throw new Error(`Expected Gitleaks ${lock.version}; run npm run secrets:install.`);
if (mode === "history" && execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" }).trim() !== "false") {
  throw new Error("Full secret scanning requires complete history. Run git fetch --unshallow before retrying.");
}
const temporary = await mkdtemp(join(tmpdir(), "cicd-secret-scan-"));
try {
  const ignore = join(temporary, "empty.ignore");
  await writeFile(ignore, "");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GITLEAKS_")) delete env[key];
  const result = spawnSync(binary, [
    "git", "--config", join(root, ".gitleaks", "config.toml"),
    "--gitleaks-ignore-path", ignore, "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color", "--verbose",
    ...(mode === "staged" ? ["--staged"] : ["--log-opts=--all"]),
    root,
  ], { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Secret scanning failed (exit ${result.status ?? result.signal}); resolve findings before retrying.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
