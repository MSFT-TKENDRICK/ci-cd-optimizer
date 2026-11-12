import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "plugins", "ci-cd-optimizer", "skills");
const target = join(root, ".github", "skills");
const [mode = "--check", ...extra] = process.argv.slice(2);
if (!["--write", "--check"].includes(mode) || extra.length) {
  throw new Error("Usage: node scripts/sync-skills.mjs [--check|--write]");
}
const skills = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
if (mode === "--write") await mkdir(target, { recursive: true });
const entries = await readdir(target);
const unexpected = entries.filter((entry) => !skills.includes(entry));
if (unexpected.length) throw new Error(`Unexpected workspace skills: ${unexpected.join(", ")}. Review them instead of silently removing them.`);
for (const name of skills) {
  const canonical = join(source, name, "SKILL.md");
  const mirror = join(target, name, "SKILL.md");
  if (mode === "--write") {
    await mkdir(join(target, name), { recursive: true });
    await copyFile(canonical, mirror);
  } else if (!(await readFile(canonical)).equals(await readFile(mirror))) {
    throw new Error(`Stale workspace skill: ${name}. Run node scripts/sync-skills.mjs --write.`);
  }
}
console.log(`${skills.length} workspace skills ${mode === "--write" ? "synchronized" : "verified"} from the canonical plugin.`);
