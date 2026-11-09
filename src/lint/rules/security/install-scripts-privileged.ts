import { commandWords } from "../caching/shared.js";
import { defineRule, commandsOf } from "../helpers.js";
import { effectivePermissions, isPrivileged, privilegedTriggers, stepHasSecretEnv, writeScopes } from "./shared.js";

const NPMRC_IGNORE = /^\s*ignore-scripts\s*=\s*true\s*$/m;

/** Package-manager install commands that run lifecycle scripts unless told not to. */
export function installCommand(command: string): string | undefined {
  const words = commandWords(command);
  const [tool, sub] = words;
  if (words.includes("--ignore-scripts") || words.some((word) => word.startsWith("--ignore-scripts="))) return undefined;
  if (tool === "npm" && (sub === "install" || sub === "i" || sub === "ci")) return `npm ${sub}`;
  if (tool === "pnpm" && (sub === "install" || sub === "i")) return `pnpm ${sub}`;
  if (tool === "yarn" && (sub === undefined || sub === "install" || sub.startsWith("--"))) return "yarn install";
  return undefined;
}

function envDisablesScripts(env: Record<string, unknown>): boolean {
  return Object.entries(env).some(
    ([name, value]) => name.toLowerCase() === "npm_config_ignore_scripts" && String(value).trim().toLowerCase() === "true",
  );
}

export default defineRule({
  meta: {
    id: "security/install-scripts-privileged",
    ruleset: "security",
    description:
      "Package installs in privileged workflows that hold secrets or a write token should pass `--ignore-scripts`.",
    rationale:
      "npm, yarn, and pnpm run `preinstall`/`install`/`postinstall` scripts from every dependency by default. In a job that triggers on `pull_request_target`, `workflow_run`, or `issue_comment` and also holds secrets or a writable token, a single compromised or attacker-controlled package can read those credentials during the install. Disabling lifecycle scripts, and running only the specific builds you need afterwards, keeps install-time code away from the credentials.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.npmjs.com/cli/commands/npm-install#ignore-scripts",
      "https://docs.github.com/en/actions/reference/security/secure-use",
      "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
    ],
    impact: "medium",
    example: {
      bad: "on: pull_request_target\npermissions:\n  pull-requests: write\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci",
      good: "on: pull_request_target\npermissions:\n  pull-requests: write\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci --ignore-scripts",
    },
  },
  check({ project, report }) {
    const npmrc = project.files.get(".npmrc")?.content;
    if (npmrc !== undefined && NPMRC_IGNORE.test(npmrc)) return;
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !isPrivileged(workflow)) continue;
      const triggers = privilegedTriggers(workflow).join(", ");
      for (const job of workflow.jobs) {
        const writes = writeScopes(effectivePermissions(workflow, job));
        for (const step of job.steps) {
          if (!step.run) continue;
          if (envDisablesScripts(workflow.env) || envDisablesScripts(job.env) || envDisablesScripts(step.env)) continue;
          const secrets = stepHasSecretEnv(workflow, job, step);
          if (writes.length === 0 && !secrets) continue;
          const holds = [
            ...(writes.length > 0 ? [writes.includes("*") ? "a `write-all` token" : `write access to ${writes.join(", ")}`] : []),
            ...(secrets ? ["secrets in its environment"] : []),
          ].join(" and ");
          for (const { command, line } of commandsOf(step)) {
            const install = installCommand(command);
            if (!install) continue;
            report({
              path: workflow.path,
              line,
              key: `${step.key}.run`,
              message: `\`${install}\` runs dependency lifecycle scripts in a ${triggers} job that holds ${holds}.`,
              suggestion:
                "Add `--ignore-scripts` (or set `ignore-scripts=true` in `.npmrc`), then run any required build steps explicitly.",
            });
          }
        }
      }
    }
  },
});
