import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(join(root, ".gitleaks", "toolchain.json"), "utf8"));
const platform = lock.platforms[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`Unsupported Gitleaks host: ${process.platform}-${process.arch}`);
const [suffix, expected] = platform;
const asset = `gitleaks_${lock.version}_${suffix}`;
const temporary = await mkdtemp(join(tmpdir(), "cicd-gitleaks-"));
try {
  const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${lock.version}/${asset}`);
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Gitleaks distribution SHA-256 mismatch.");
  const archive = join(temporary, asset);
  await writeFile(archive, bytes);
  const name = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${quote(temporary)})`], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", temporary, name], { stdio: "inherit" });
  }
  await chmod(join(temporary, name), 0o755);
  const version = execFileSync(join(temporary, name), ["version"], { encoding: "utf8" }).trim();
  if (version !== lock.version) throw new Error(`Unexpected Gitleaks version: ${version}`);
  const bin = join(root, ".gitleaks", "bin");
  await mkdir(bin, { recursive: true });
  // Copy on the destination filesystem, then atomically replace the executable.
  const destination = join(bin, `${name}.tmp`);
  await writeFile(destination, await readFile(join(temporary, name)), { mode: 0o755 });
  await rename(destination, join(bin, name));
  console.log(`Installed SHA-256-verified Gitleaks ${lock.version}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
