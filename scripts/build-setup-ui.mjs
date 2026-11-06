import { join } from "node:path";
import { OUTPUT_FILES, ROOT, buildSetupUi, findStale, writeSetupUi } from "./setup-ui-bundle.mjs";

const out = join(ROOT, "dist-setup");
const check = process.argv.includes("--check");

try {
  const files = await buildSetupUi();
  if (check) {
    const stale = await findStale(files, out);
    if (stale.length > 0) {
      console.error(`dist-setup is out of date (${stale.join(", ")}). Run npm run build:ui and commit the result.`);
      process.exit(1);
    }
    console.log(`dist-setup is up to date (${OUTPUT_FILES.length} files).`);
  } else {
    await writeSetupUi(files, out);
    for (const [name, text] of files) console.log(`dist-setup/${name}  ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
