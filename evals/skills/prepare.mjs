import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..", "..");
const [destination, ref] = process.argv.slice(2);
if (!destination) throw new Error("Usage: node evals/skills/prepare.mjs <new-destination> [git-ref]");
const output = resolve(root, destination);
const within = relative(join(root, ".agent-artifacts"), output);
if (!within || within.startsWith("..") || resolve(within) === within) {
  throw new Error("Destination must be a new directory inside .agent-artifacts");
}
const names = ["optimize-ci-pipeline", "analyze-ci-run", "triage-cicd-findings"];
const files = names.flatMap((name) => [
  `plugins/ci-cd-optimizer/skills/${name}/SKILL.md`,
  `.github/skills/${name}/SKILL.md`,
]);
const revision = ref ? execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim() : undefined;
const tracked = revision ? new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", ...files], { cwd: root, encoding: "utf8" }).trim().split("\n")) : undefined;
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
for (const file of files) {
  let content;
  if (revision) {
    if (!tracked.has(file)) {
      if (file.startsWith(".github/")) continue;
      throw new Error(`Missing canonical skill at ${revision}: ${file}`);
    }
    content = execFileSync("git", ["show", `${revision}:${file}`], { cwd: root });
  } else {
    try {
      content = await readFile(join(root, file));
    } catch (error) {
      if (error.code === "ENOENT" && file.startsWith(".github/")) continue;
      throw error;
    }
  }
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
console.log(`Prepared skill-only fixture from ${revision ?? "working tree"} at ${output}`);
