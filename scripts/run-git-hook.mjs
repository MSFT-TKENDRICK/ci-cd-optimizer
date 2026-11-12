import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hook = process.argv[2];
if (!["pre-commit", "pre-push"].includes(hook)) throw new Error("Unknown Git hook.");
const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${hook} check failed (exit ${result.status ?? result.signal}).`);
};
run([".gitleaks/better-gitleaks", hook === "pre-commit" ? "staged" : "history"]);
if (hook === "pre-commit") {
  run(["node_modules/eslint/bin/eslint.js", "."]);
  run(["node_modules/tsx/dist/cli.mjs", "src/lint-bin.ts", "--fail-on", "error"]);
} else {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "ci:check-generated"], {
    cwd: root, stdio: "inherit", windowsHide: true, shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Generated-output push gate failed.");
}
