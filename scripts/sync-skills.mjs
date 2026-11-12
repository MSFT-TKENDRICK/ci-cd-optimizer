import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

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
  const canonical = join(source, name);
  const mirror = join(target, name);
  const inventory = async (directory) => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() && !entry.isDirectory())) throw new Error(`Non-regular skill entry: ${directory}`);
    return entries.filter((entry) => entry.isFile()).map((entry) => relative(directory, join(entry.parentPath, entry.name))).sort();
  };
  const files = await inventory(canonical);
  if (mode === "--write") {
    await cp(canonical, mirror, { recursive: true });
  }
  if (JSON.stringify(await inventory(mirror)) !== JSON.stringify(files)) throw new Error(`Unexpected or missing files in workspace skill: ${name}`);
  for (const file of files) {
    if (!(await readFile(join(canonical, file))).equals(await readFile(join(mirror, file)))) {
      throw new Error(`Stale workspace skill: ${name}/${file}. Run node scripts/sync-skills.mjs --write.`);
    }
  }
}
console.log(`${skills.length} workspace skills ${mode === "--write" ? "synchronized" : "verified"} from the canonical plugin.`);
