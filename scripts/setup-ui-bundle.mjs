import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const OUTPUT_FILES = ["app.css", "app.js", "index.html", "mcp.html"];

const STYLESHEET_TAG = '<link rel="stylesheet" href="/assets/app.css" />';
const SCRIPT_TAG = '<script type="module" src="/assets/app.js"></script>';

const lf = (text) => text.replace(/\r\n/g, "\n");

// A plain string replacement would expand `$&` and friends, which minified code is full of.
function replaceOnce(html, tag, replacement) {
  const parts = html.split(tag);
  if (parts.length !== 2) throw new Error(`ui/setup/index.html must contain ${tag} exactly once.`);
  return parts[0] + replacement + parts[1];
}

function tailwindCli(root) {
  const require = createRequire(join(root, "package.json"));
  const manifestPath = require.resolve("@tailwindcss/cli/package.json");
  const { bin } = require(manifestPath);
  return join(dirname(manifestPath), typeof bin === "string" ? bin : bin.tailwindcss);
}

function stylesheet(root) {
  const run = spawnSync(process.execPath, [tailwindCli(root), "-i", join(root, "ui/setup/src/styles.css"), "--minify"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.status !== 0 || !run.stdout) throw new Error(`Tailwind could not build the setup styles.\n${run.stderr}`);
  return lf(run.stdout);
}

async function bundle(root, entry) {
  const result = await build({
    entryPoints: [join(root, "ui/setup/src", entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    tsconfig: join(root, "ui/setup/tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "warning",
    // shadcn sources keep their "use client" directive, which means nothing in a plain SPA.
    logOverride: { "ignored-directive": "silent" },
  });
  if (result.warnings.length > 0) throw new Error(`esbuild reported ${result.warnings.length} warning(s) while bundling ${entry}.`);
  const [output] = result.outputFiles;
  if (!output || result.outputFiles.length !== 1) throw new Error(`esbuild produced an unexpected output for ${entry}.`);
  return lf(output.text);
}

async function inlineScript(source) {
  if (source.includes("<!--")) throw new Error("The MCP bundle contains an HTML comment opener, which is unsafe inside an inline script.");
  const safe = source.replace(/<\/script/gi, "<\\/script");
  await transform(safe, { loader: "js", format: "esm" });
  return safe;
}

function inlineStyle(source) {
  if (/<\/style/i.test(source)) throw new Error("The setup styles contain a closing style tag, which is unsafe inside an inline style.");
  return source;
}

/** Builds every setup UI asset in memory and returns them as a map of file name to text. */
export async function buildSetupUi({ root = ROOT } = {}) {
  const template = lf(await readFile(join(root, "ui/setup/index.html"), "utf8"));
  const [css, httpJs, mcpJs] = [stylesheet(root), await bundle(root, "main-http.tsx"), await bundle(root, "main-mcp.tsx")];
  const style = `<style>${inlineStyle(css)}</style>`;
  const script = `<script type="module">${await inlineScript(mcpJs)}</script>`;
  const mcp = replaceOnce(replaceOnce(template, STYLESHEET_TAG, style), SCRIPT_TAG, script);
  // Confirms the template still has both placeholders, so the HTTP shell references real assets.
  replaceOnce(replaceOnce(template, STYLESHEET_TAG, ""), SCRIPT_TAG, "");
  return new Map([
    ["app.css", css],
    ["app.js", httpJs],
    ["index.html", template],
    ["mcp.html", mcp],
  ]);
}

export async function writeSetupUi(files, out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([...files].map(([name, text]) => writeFile(join(out, name), text)));
}

/** Names of the files in `out` that differ from a fresh build, are missing, or are unexpected. */
export async function findStale(files, out) {
  const stale = [];
  for (const [name, text] of files) {
    const current = await readFile(join(out, name), "utf8").then(lf, () => null);
    if (current !== text) stale.push(name);
  }
  const present = await readdir(out).catch(() => []);
  for (const name of present) if (!files.has(name)) stale.push(name);
  return stale.sort();
}
