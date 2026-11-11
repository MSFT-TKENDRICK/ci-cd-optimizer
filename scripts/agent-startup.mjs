import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const { values } = parseArgs({
  options: { repo: { type: "string" }, auth: { type: "string", default: "environment" }, since: { type: "string" }, "install-hooks": { type: "boolean" } },
});
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(values.repo ?? "") ||
    [".", ".."].includes(values.repo.split("/")[1])) throw new Error("Provide an explicit --repo owner/repo authorization; it is never inferred from git remotes.");
if (!["environment", "github-cli"].includes(values.auth)) throw new Error("--auth must be environment or github-cli.");
const directory = join(root, ".agent-artifacts");
await mkdir(directory, { recursive: true });
const inside = relative(root, await realpath(directory));
if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Agent state must remain inside this workspace.");
const path = join(directory, "ci-feedback.json");
let existing;
try {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 4096) throw new Error("Existing feedback configuration is not a bounded regular file.");
  try { existing = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Existing feedback configuration is not valid JSON."); }
  if (existing?.version !== 1 || typeof existing.repo !== "string" || !["environment", "github-cli"].includes(existing.auth) ||
      typeof existing.since !== "string" || !Number.isFinite(Date.parse(existing.since))) throw new Error("Existing feedback configuration is invalid.");
}
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing && (existing.repo !== values.repo.toLowerCase() || existing.auth !== values.auth)) {
  throw new Error("Existing feedback authorization differs. Review and remove .agent-artifacts/ci-feedback.json before changing its repository or authentication mode.");
}
const since = values.since ?? existing?.since ?? new Date().toISOString();
if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(since) || !Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.now()) throw new Error("--since must be a past ISO timestamp.");
await readFile(resolve(root, "plugins/ci-cd-optimizer/server/cicd-agents.mjs"));
const temporary = `${path}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify({ version: 1, repo: values.repo.toLowerCase(), auth: values.auth, since }) + "\n", { flag: "wx" });
try { await rename(temporary, path); }
finally { await rm(temporary, { force: true }); }
if (values["install-hooks"]) {
  const hook = await stat(join(root, ".githooks", "pre-push"));
  if (!hook.isFile() || (process.platform !== "win32" && !(hook.mode & 0o111))) throw new Error("The generated-output pre-push hook is missing or not executable.");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  let configured = "";
  try { configured = git("config", "--get", "core.hooksPath"); }
  catch (error) { if (error.status !== 1) throw error; }
  if (configured && configured !== ".githooks") throw new Error("Existing Git hooks configuration was preserved. Review it before installing generated-output checks.");
  if (!configured) {
    let existingHook = false;
    try { await stat(resolve(root, git("rev-parse", "--git-path", "hooks/pre-push"))); existingHook = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existingHook) throw new Error("An existing pre-push hook was preserved; install the generated-output check explicitly.");
    git("config", "--local", "core.hooksPath", ".githooks");
  }
}
console.log(`CI feedback configured for ${values.repo} using ${values.auth}. The Copilot extension starts the workspace's stdio MCP server when its harness joins. No credentials were written.`);
