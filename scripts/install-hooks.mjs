import { execFileSync } from "node:child_process";
import { chmod, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function installHooks(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const top = git("rev-parse", "--show-toplevel");
  if (await realpath(top) !== await realpath(root)) throw new Error("Install hooks only from the repository root.");
  let configured = "";
  try { configured = git("config", "--get", "core.hooksPath"); }
  catch (error) { if (error.status !== 1) throw error; }
  if (configured && configured !== ".githooks") throw new Error("Existing Git hooks configuration was preserved. Review it before installing mandatory checks.");
  if (!configured) {
    let names = [];
    try { names = await readdir(resolve(root, git("rev-parse", "--git-path", "hooks"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const existing = names.filter((name) => !name.endsWith(".sample"));
    if (existing.length) throw new Error(`An existing ${existing[0]} hook was preserved; migrate existing checks explicitly before installing managed hooks.`);
  }
  for (const name of ["pre-commit", "pre-push"]) {
    const path = join(root, ".githooks", name);
    if (!(await stat(path)).isFile()) throw new Error(`Missing managed ${name} hook.`);
    await chmod(path, 0o755);
  }
  git("config", "--local", "core.hooksPath", ".githooks");
  console.log("Managed Git hooks installed. Commit and push gates fail closed when checks are unavailable.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installHooks(fileURLToPath(new URL("../", import.meta.url)));
}
