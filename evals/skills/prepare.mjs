import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
const directories = names.flatMap((name) => [
  `plugins/ci-cd-optimizer/skills/${name}`,
  `.github/skills/${name}`,
]);
const revision = ref ? execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim() : undefined;
const files = revision ? execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", ...directories], { cwd: root, encoding: "utf8" }).trim().split("\n") : [];
if (!revision) {
  for (const directory of directories) {
    try {
      const path = join(root, directory);
      const entries = await readdir(path, { recursive: true, withFileTypes: true });
      if (entries.some((entry) => !entry.isFile() && !entry.isDirectory())) throw new Error(`Non-regular skill entry: ${directory}`);
      files.push(...entries.filter((entry) => entry.isFile()).map((entry) => `${directory}/${relative(path, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`));
    } catch (error) {
      if (error.code === "ENOENT" && directory.startsWith(".github/")) continue;
      throw error;
    }
  }
}
for (const name of names) {
  if (!files.includes(`plugins/ci-cd-optimizer/skills/${name}/SKILL.md`)) throw new Error(`Missing canonical skill: ${name}`);
}
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
for (const file of files) {
  let content;
  if (revision) {
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
