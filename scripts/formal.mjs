import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkToolchain, dafny, lock, root, z3 } from "./formal-toolchain.mjs";

const mode = process.argv[2];
if (!["verify", "generate", "check"].includes(mode)) throw new Error("Usage: node scripts/formal.mjs verify|generate|check");
checkToolchain();
const sources = ["Kernel.dfy", "CacheKey.dfy", "Selection.dfy", "Policy.dfy", "CiPolicy.dfy"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (text) => text.replaceAll("\r\n", "\n");
async function sourceFiles(directory, prefix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await sourceFiles(resolve(directory, entry.name), `${prefix}/${entry.name}`));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(`${prefix}/${entry.name}`);
  }
  return files;
}
async function digestFiles(paths) {
  return sha((await Promise.all(paths.sort().map(async (path) => `${path}\0${sha(normalize(await readFile(resolve(root, ...path.split("/")), "utf8")))}\n`))).join(""));
}
const sourceText = (await Promise.all(sources.map(async (name) => `${name}\0${normalize(await readFile(resolve(root, "formal", name), "utf8"))}`))).join("\0");
if (/\b(assume|axiom|extern)\b|\{:\s*verify\s+false/.test(sourceText.replace(/\/\/[^\n]*/g, ""))) {
  throw new Error("Proof sources must not use axioms, assumptions, externs, or disabled verification.");
}
const args = [
  "formal/Kernel.dfy", "--verify-included-files", "--manual-lemma-induction",
  "--solver-path", z3, "--cores", "2", "--verification-time-limit", "60", "--enforce-determinism",
];
if (mode === "verify") {
  execFileSync(dafny, ["verify", ...args], { cwd: root, stdio: "inherit" });
} else {
  await mkdir(resolve(root, ".proof-build"), { recursive: true });
  execFileSync(dafny, ["translate", "js", ...args, "--include-runtime", "--output", ".proof-build/kernel.js"], { cwd: root, stdio: "inherit" });
  const raw = normalize(await readFile(resolve(root, ".proof-build/kernel.js"), "utf8"));
  const requireLine = "const BigNumber = require('bignumber.js');";
  if (raw.split(requireLine).length !== 2 || /\brequire\(/.test(raw.replace(requireLine, ""))) {
    throw new Error("Unexpected translator output; review the ESM adaptation.");
  }
  const adapted = raw.replace(requireLine, 'import { BigNumber } from "bignumber.js";').replaceAll("let $module = {};", "let $module: any = {};");
  const generated = `// @ts-nocheck\n// GENERATED: npm run formal:generate; do not edit.\n${adapted}\nexport { _dafny as Dafny, CacheKey, Selection, Policy, CiPolicy };\n`;
  const manifest = {
    schema: "cicd-optimizer/formal-v1",
    dafny: lock.dafny,
    z3: lock.z3,
    arithmetic: "unbounded-integers; scalar-Unicode; objective-10000; ties-to-positive-infinity",
    modelSha256: sha(sourceText),
    translatorOutputSha256: sha(raw),
    generatedSha256: sha(generated),
    toolchainSha256: sha(normalize(await readFile(resolve(root, "formal/toolchain.json"), "utf8"))),
    implementationSha256: await digestFiles((await sourceFiles(resolve(root, "src"), "src")).filter((path) => !["src/formal/generated/kernel.ts", "src/formal/generated/manifest.ts"].includes(path))),
    generatorSha256: await digestFiles(["scripts/formal.mjs", "scripts/formal-toolchain.mjs", "scripts/assurance.ts"]),
    dependenciesSha256: await digestFiles(["package.json", "package-lock.json"]),
  };
  const files = {
    "kernel.ts": generated,
    "manifest.ts": `// GENERATED: npm run formal:generate; do not edit.\nexport const PROOF_BUILD = ${JSON.stringify(manifest, null, 2)} as const;\n`,
  };
  await mkdir(resolve(root, "src/formal/generated"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, "src/formal/generated", name);
    if (mode === "check") {
      if (await readFile(path, "utf8") !== content) throw new Error(`Stale generated proof artifact: ${name}. Run npm run formal:generate.`);
    } else {
      await writeFile(path, content);
    }
  }
  console.log(`Verified ${manifest.modelSha256}; generated runtime ${manifest.generatedSha256}`);
}
