import { pathToFileURL } from "node:url";
import { githubRequest, verifyInstallation } from "./setup-app.mjs";

export async function verifyConfiguredApp(env = process.env, request = githubRequest) {
  const repo = env.GITHUB_REPOSITORY;
  const id = Number(env.APP_ID);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(id) || id <= 0 ||
    env.EXPECTED_APP_ID !== String(id) || env.APP_ID !== String(id)) {
    throw new Error("The configured App ID must match the requested App and repository.");
  }
  if (!env.APP_PRIVATE_KEY) throw new Error("CICD_OPTIMIZER_APP_PRIVATE_KEY is missing.");
  await verifyInstallation(repo, { id, pem: env.APP_PRIVATE_KEY }, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyConfiguredApp().then(() => {
    console.log("App installation verified; the repository-scoped verification token was revoked.");
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
