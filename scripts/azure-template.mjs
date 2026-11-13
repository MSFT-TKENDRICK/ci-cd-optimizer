// Builds infra/azure/azuredeploy.json (the Deploy to Azure template) from main.bicep with a
// pinned, SHA-256-verified Bicep CLI. --check rebuilds into a temp directory and fails on drift.
// BICEP=/path/to/bicep overrides the download, but its version must still match the pin.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.44.1";
const ASSETS = {
  "linux-x64": ["bicep-linux-x64", "e17dc9a9888184886bb0c0051a3230b83b19f342749999f707bc571c3dfd2f45"],
  "linux-arm64": ["bicep-linux-arm64", "a9c73b96975a17e49b5dd66725c8dc2451501c77b194156d938719ee4990318b"],
  "darwin-x64": ["bicep-osx-x64", "9d3c8f412a82670b2d89126eda5210ce1290a5e3790f373094ea98c813cd90a9"],
  "darwin-arm64": ["bicep-osx-arm64", "d96a185cd7ce6a685a9d43130ff2298597603d7be9f782c7bef5171ed6884795"],
  "win32-x64": ["bicep-win-x64.exe", "5153ab5898e70f1f822e0b844ae902a5acc5692f5a6303814af7b202e1072160"],
  "win32-arm64": ["bicep-win-arm64.exe", "400ce5b9451b386d9026beca3850c23e208489c3cf1ec0c02508dd7d2206563e"],
};

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "infra/azure/main.bicep");
const target = resolve(root, "infra/azure/azuredeploy.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (text) => text.replace(/\r\n/g, "\n").trimEnd();

function verifyVersion(bicep) {
  const output = execFileSync(bicep, ["--version"], { encoding: "utf8" }).trim();
  if (!output.includes(`version ${VERSION} `)) throw new Error(`Expected Bicep CLI ${VERSION}, found: ${output}`);
  return bicep;
}

async function pinnedBicep() {
  if (process.env.BICEP) return verifyVersion(process.env.BICEP);
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`No pinned Bicep CLI for ${process.platform}-${process.arch}; set BICEP to a ${VERSION} binary.`);
  const [name, digest] = asset;
  const home = resolve(root, ".agent-artifacts", "tools", `bicep-${VERSION}`);
  const binary = join(home, name);
  if (!existsSync(binary) || sha256(readFileSync(binary)) !== digest) {
    const url = `https://github.com/Azure/bicep/releases/download/v${VERSION}/${name}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bicep download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== digest) throw new Error("Pinned Bicep CLI SHA-256 mismatch.");
    mkdirSync(home, { recursive: true });
    writeFileSync(`${binary}.partial`, bytes);
    chmodSync(`${binary}.partial`, 0o755);
    renameSync(`${binary}.partial`, binary);
  }
  return verifyVersion(binary);
}

function build(bicep, outfile) {
  const result = spawnSync(bicep, ["build", source, "--outfile", outfile], { encoding: "utf8", timeout: 600_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0 || /\b(warning|error)\b/i.test(output)) {
    throw new Error(`Bicep build failed or reported diagnostics (exit ${result.status}):\n${output}`);
  }
}

const bicep = await pinnedBicep();
if (process.argv.includes("--check")) {
  const temp = mkdtempSync(join(tmpdir(), "azure-template-"));
  try {
    const built = join(temp, "azuredeploy.json");
    build(bicep, built);
    if (normalize(readFileSync(built, "utf8")) !== normalize(readFileSync(target, "utf8"))) {
      console.error("infra/azure/azuredeploy.json is stale; run npm run azure:template and commit the result.");
      process.exit(1);
    }
    console.log(`infra/azure/azuredeploy.json matches main.bicep (Bicep ${VERSION}).`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  build(bicep, target);
  console.log(`Wrote infra/azure/azuredeploy.json with Bicep ${VERSION}.`);
}
