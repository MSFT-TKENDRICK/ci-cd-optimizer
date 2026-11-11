import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const lock = JSON.parse(await readFile(resolve(root, "formal/toolchain.json"), "utf8"));
const platform = lock.platforms[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`Unsupported proof host ${process.platform}-${process.arch}; use x64 Linux or Windows (ARM64 uses x64 emulation).`);
export const home = resolve(root, ".proof-tools", lock.dafny);
export const dafny = resolve(home, "dafny", process.platform === "win32" ? "dafny.exe" : "dafny");
export const z3 = resolve(home, "dafny", "z3", "bin", process.platform === "win32" ? `z3-${lock.z3}.exe` : `z3-${lock.z3}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function checkToolchain() {
  const rows = [];
  function inventory(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) inventory(path, `${name}/`);
      else if (entry.isFile()) rows.push(`${name}\0${sha256(readFileSync(path))}\n`);
      else throw new Error(`Unsupported file in proof toolchain: ${name}`);
    }
  }
  inventory(resolve(home, "dafny"));
  if (sha256(rows.sort().join("")) !== platform.installedFilesSha256) {
    throw new Error("Installed proof toolchain differs from the pinned distribution; reinstall with npm run formal:setup.");
  }
  const version = execFileSync(dafny, ["--version"], { encoding: "utf8", cwd: root }).trim();
  const solver = execFileSync(z3, ["--version"], { encoding: "utf8", cwd: root }).trim();
  if (!version.startsWith(`${lock.dafny}+`) && version !== lock.dafny) throw new Error(`Unexpected Dafny: ${version}`);
  if (!solver.startsWith(`Z3 version ${lock.z3} `)) throw new Error(`Unexpected Z3: ${solver}`);
  return { version, solver, installedFilesSha256: platform.installedFilesSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(reuseVerifiedToolchain() ?? await installToolchain());
}

function reuseVerifiedToolchain() {
  try {
    const result = checkToolchain();
    console.log(`Reusing verified toolchain at .proof-tools/${lock.dafny}`);
    return result;
  } catch {
    return undefined;
  }
}

async function installToolchain() {
  await rm(resolve(home, "dafny"), { recursive: true, force: true });
  const url = `https://github.com/dafny-lang/dafny/releases/download/v${lock.dafny}/${platform.asset}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Toolchain download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== platform.sha256) throw new Error("Pinned Dafny distribution SHA-256 mismatch.");
  await mkdir(home, { recursive: true });
  const archive = resolve(home, platform.asset);
  await writeFile(archive, bytes);
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(home)} -Force`], { cwd: root, stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", "-o", archive, "-d", home], { cwd: root, stdio: "inherit" });
  }
  await rm(archive, { force: true });
  return checkToolchain();
}
