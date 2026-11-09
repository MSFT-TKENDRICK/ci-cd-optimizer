import { lineText } from "../../fix.js";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { commandsOf, defineRule, steps } from "../helpers.js";
import { normalizeAccess } from "./shared.js";

const TO_JSON_SECRETS = /toJSON\s*\(\s*secrets\s*\)/i;
const SECRET_EXPRESSION = /\$\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/i;
const PRINT = /^(?:echo|printf)\b/;

function secretEnvNames(workflow: WorkflowModel, job: JobModel, step: StepModel): string[] {
  const names: string[] = [];
  for (const env of [workflow.env, job.env, step.env]) {
    for (const [name, value] of Object.entries(env)) {
      if (
        typeof value === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        /\$\{\{\s*secrets\.[A-Za-z_]/i.test(normalizeAccess(value))
      ) {
        names.push(name);
      }
    }
  }
  return names;
}

/** Consumers that read a secret from stdin without echoing it. */
const SAFE_CONSUMER = /--password-stdin\b|--with-token\b|^\s*(?:gpg\b.*--import|ssh-add\b|docker\s+secret\s+create\b)/;
/** Filters that re-emit (often transformed, and therefore unmasked) input on stdout. */
const LEAKY_FILTER = /^\s*(?:base64|base32|basenc|xxd|od|hexdump|rev|tee|cat|tr|sed|awk|cut|fold|jq|openssl)\b/;
const REDIRECT = /(?:^|[^<\d&])\d?>>?\s*(&\d|"[^"]*"|'[^']*'|\S+)/;
const LOGGED_TARGET = /^(?:&[12]|\/dev\/std(?:out|err))$|GITHUB_STEP_SUMMARY/;

/** Whether the output of a printing pipeline ends up in the job log or step summary. */
function reachesLog(command: string): boolean {
  const stages = command.split(/(?<!\|)\|(?!\|)/);
  const last = stages[stages.length - 1] ?? "";
  const redirect = REDIRECT.exec(last)?.[1];
  if (redirect !== undefined) return LOGGED_TARGET.test(redirect.replace(/^["']|["']$/g, ""));
  if (stages.length === 1) return true;
  if (SAFE_CONSUMER.test(last)) return false;
  return LEAKY_FILTER.test(last);
}

function printsSecret(command: string, envNames: string[]): string | undefined {
  if (!PRINT.test(command) || command.includes("::add-mask::") || !reachesLog(command)) return undefined;
  const direct = SECRET_EXPRESSION.exec(normalizeAccess(command))?.[0];
  if (direct !== undefined) return direct;
  return envNames.find((name) => new RegExp(String.raw`\$(?:\{${name}\}|${name}\b)`).test(command));
}

export default defineRule({
  meta: {
    id: "security/secrets-bulk-expose",
    ruleset: "security",
    description: "Workflows must not serialize the whole `secrets` context with `toJSON(secrets)` or print secrets with `echo`/`printf`.",
    rationale:
      "`toJSON(secrets)` hands every repository and organization secret to a single step, so one compromised action or script leaks all of them; it also defeats per-job least privilege. Printing a secret relies entirely on log masking, which misses transformed values (base64, substrings, JSON escapes) and leaves the value in step summaries or downstream tools. Pass only the specific secrets a step needs through `env:` and never write them to stdout.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/security/secure-use#use-secrets-for-sensitive-information",
      "https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions",
    ],
    impact: "high",
    example: {
      bad: "- env:\n    ALL_SECRETS: ${{ toJSON(secrets) }}\n  run: ./deploy.sh",
      good: "- env:\n    DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n  run: ./deploy.sh",
    },
  },
  check({ project, report }) {
    const models = [...project.workflows, ...project.actions];
    for (const workflow of models) {
      const file = project.files.get(workflow.path);
      if (!file) continue;
      const lineCount = file.content.split("\n").length;
      for (let line = 1; line <= lineCount; line++) {
        const text = lineText(file.content, line);
        if (/^\s*#/.test(text) || !TO_JSON_SECRETS.test(text)) continue;
        report({
          path: workflow.path,
          line,
          message: "`toJSON(secrets)` exposes every secret available to the workflow at once.",
          suggestion: "Pass only the individual secrets this step needs, e.g. `TOKEN: ${{ secrets.TOKEN }}`.",
        });
      }
    }
    for (const { workflow, job, step } of steps(models)) {
      const envNames = secretEnvNames(workflow, job, step);
      for (const { command, line } of commandsOf(step)) {
        const leaked = printsSecret(command.trim(), envNames);
        if (leaked === undefined) continue;
        report({
          path: workflow.path,
          line,
          key: `${step.key}.run`,
          message: `\`${command.trim().split(/\s+/)[0] ?? "echo"}\` prints a secret (${leaked}) to the job log, relying on masking to hide it.`,
          suggestion: "Don't print secrets. Pass the value to the tool that needs it via `env:` or a file with restricted permissions.",
        });
      }
    }
  },
});
