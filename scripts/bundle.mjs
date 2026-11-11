import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { check: { type: "boolean" } } });
if (positionals.length !== 1 || !["action", "agents", "all"].includes(positionals[0])) throw new Error("Usage: node scripts/bundle.mjs <action|agents|all> [--check]");
const root = fileURLToPath(new URL("../", import.meta.url));
for (const [kind, entry, outfile] of [
  ["action", "src/action.ts", "dist-action/index.js"],
  ["agents", "src/agent-bundle.ts", "plugins/ci-cd-optimizer/server/cicd-agents.mjs"],
]) {
  if (positionals[0] !== "all" && positionals[0] !== kind) continue;
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], outfile, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    legalComments: "none", write: !values.check,
  });
  if (values.check && !Buffer.from(result.outputFiles[0].contents).equals(await readFile(join(root, outfile)))) {
    throw new Error(`${outfile} is stale. Run npm run ci:prepare before pushing; the parity gate remains required.`);
  }
}
