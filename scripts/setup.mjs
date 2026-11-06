import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { prepareSetup, startSetup } from "./setup-session.mjs";

const USAGE = "Usage: npm run setup -- --repo OWNER/REPOSITORY [--resume-app APP-SLUG]\nRequires Node 22+ and an authenticated GitHub CLI with repository admin access. Resume reuses saved credential metadata without retrieving or replacing secrets. Every credential/installation step requires an explicit button.";

async function main() {
  const { values } = parseArgs({ options: { repo: { type: "string" }, "resume-app": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const setup = await startSetup(await prepareSetup({ repo: values.repo ?? process.env.GITHUB_REPOSITORY, resumeApp: values["resume-app"] }));
  console.log(`Open in your signed-in browser:\n${setup.url}\nNo credentials are logged. Stop with Ctrl+C after completing setup.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void setup.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
