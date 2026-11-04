import { hasTrigger, type JobModel, type StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { defineRule, isKnownMonorepo, jobCommands } from "../helpers.js";

interface Finding {
  tool: string;
  what: string;
  suggestion: string;
}

/** Job/step conditions that only run outside pull requests. */
const NON_PR_CONDITION =
  /github\.event_name\s*==\s*['"](?:push|schedule|workflow_dispatch|release|merge_group)['"]|github\.ref\s*==\s*['"]refs\/(?:heads|tags)\//;

const isTestTarget = (target: string): boolean =>
  /^(?:tests?|e2e|integration|unit|test[:-][\w:-]+|[\w-]+[:-](?:tests?|e2e))$/i.test(target);

const isFlag = (token: string): boolean => token.startsWith("-");

const targetList = (targets: string[]): string =>
  `the ${targets.map((target) => `\`${target}\``).join(", ")} target${targets.length === 1 ? "" : "s"}`;

/** Non-flag tokens that follow `start` until the next flag. */
function operands(tokens: string[], start: number): string[] {
  const result: string[] = [];
  for (let index = start; index < tokens.length && !isFlag(tokens[index] ?? "-"); index++) result.push(tokens[index] ?? "");
  return result;
}

function flagValues(tokens: string[], ...flags: string[]): string[] {
  return tokens.flatMap((token, index) => {
    const flag = flags.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
    if (!flag) return [];
    if (token.startsWith(`${flag}=`)) return [token.slice(flag.length + 1)];
    return operands(tokens, index + 1);
  });
}

const has = (tokens: string[], ...flags: string[]): boolean =>
  tokens.some((token) => flags.some((flag) => token === flag || token.startsWith(`${flag}=`)));

/** The script a package manager runs (`pnpm -r test`, `npm run test -ws`, `yarn workspaces foreach -j 4 run test`). */
function scriptName(tokens: string[], toolIndex: number): string | undefined {
  const rest = tokens.slice(toolIndex + 1).filter((token) => !isFlag(token) && !/^\d+$/.test(token));
  const run = rest.findIndex((token) => token === "run" || token === "run-script");
  return run >= 0 ? rest[run + 1] : rest[0];
}

function npmAlternative(project: ProjectModel, script: string): string {
  const tools = project.facts.monorepoTools.value;
  if (tools.includes("nx")) return `Use \`nx affected -t ${script}\` so only projects affected by the change run.`;
  if (tools.includes("turbo")) return `Use \`turbo run ${script} --affected\` so only packages affected by the change run.`;
  return `Compute the changed workspaces (for example from \`git diff --name-only origin/\${{ github.base_ref }}...HEAD\`) and pass them with \`-w <workspace>\`, or adopt a task runner with affected detection (Nx, Turborepo).`;
}

function detect(project: ProjectModel, command: string): Finding | undefined {
  if (/^(?:echo|printf)\b/.test(command)) return undefined;
  const tokens = command.replace(/["']/g, "").split(/\s+/).filter(Boolean);
  const at = (name: RegExp): number => tokens.findIndex((token) => name.test(token));

  const nx = at(/^(?:.*\/)?nx$/);
  if (nx >= 0 && tokens[nx + 1] === "run-many") {
    const targets = flagValues(tokens, "-t", "--target", "--targets").flatMap((value) => value.split(","));
    if (!targets.some(isTestTarget) || has(tokens, "-p", "--projects")) return undefined;
    return {
      tool: "nx run-many",
      what: `${targetList(targets)} for every project`,
      suggestion: `Use \`nx affected -t ${targets.join(" ")}\` with the base set by \`nrwl/nx-set-shas@v5\` (or \`--base=origin/\${{ github.base_ref }}\`) so only affected projects run.`,
    };
  }

  const turbo = at(/^(?:.*\/)?turbo$/);
  if (turbo >= 0) {
    const tasks = operands(tokens, tokens[turbo + 1] === "run" ? turbo + 2 : turbo + 1);
    if (!tasks.some(isTestTarget) || has(tokens, "--affected", "--filter", "-F")) return undefined;
    return {
      tool: "turbo run",
      what: `${targetList(tasks)} for every package`,
      suggestion: `Use \`turbo run ${tasks.join(" ")} --affected\` (it compares against \`GITHUB_BASE_REF\` on pull requests; fetch the base first) so only changed packages and their dependents run.`,
    };
  }

  const lerna = at(/^(?:.*\/)?lerna$/);
  if (lerna >= 0 && tokens[lerna + 1] === "run") {
    const script = tokens.slice(lerna + 2).find((token) => !isFlag(token));
    if (!script || !isTestTarget(script) || has(tokens, "--since", "--scope")) return undefined;
    return {
      tool: "lerna run",
      what: `the \`${script}\` script in every package`,
      suggestion: `Use \`lerna run ${script} --since origin/\${{ github.base_ref }}\` so only packages changed since the base and their dependents run (fetch the base first).`,
    };
  }

  const yarn = at(/^yarn$/);
  if (yarn >= 0 && tokens[yarn + 1] === "workspaces" && (tokens[yarn + 2] === "foreach" || tokens[yarn + 2] === "run")) {
    const script = scriptName(tokens, yarn + 2);
    if (!script || !isTestTarget(script) || has(tokens, "--since", "--from", "--include")) return undefined;
    return {
      tool: "yarn workspaces",
      what: `the \`${script}\` script in every workspace`,
      suggestion: `Use \`yarn workspaces foreach -A --since=origin/\${{ github.base_ref }} run ${script}\` (Yarn 2+) so only workspaces changed since the base run, or a task runner with dependency-aware affected detection (Nx, Turborepo).`,
    };
  }

  const pnpm = at(/^pnpm$/);
  if (pnpm >= 0 && has(tokens, "-r", "--recursive") && !has(tokens, "--filter", "-F")) {
    const script = scriptName(tokens, pnpm);
    if (!script || !isTestTarget(script)) return undefined;
    return {
      tool: "pnpm -r",
      what: `the \`${script}\` script in every package`,
      suggestion: `Use \`pnpm --filter "...[origin/\${{ github.base_ref }}]" ${script}\` so only packages changed since the base and their dependents run (fetch the base first).`,
    };
  }

  const npm = at(/^npm$/);
  if (npm >= 0 && has(tokens, "--workspaces", "-ws") && !has(tokens, "--workspace", "-w")) {
    const script = scriptName(tokens, npm);
    if (!script || !isTestTarget(script)) return undefined;
    return { tool: "npm --workspaces", what: `the \`${script}\` script in every workspace`, suggestion: npmAlternative(project, script) };
  }

  const bazel = at(/^(?:.*\/)?bazel(?:isk)?$/);
  if (bazel >= 0 && tokens[bazel + 1] === "test" && tokens.includes("//...")) {
    return {
      tool: "bazel test //...",
      what: "every test target in the workspace",
      suggestion:
        "Compute affected targets from the diff (for example with bazel-diff or target-determinator) and pass only those to `bazel test`; a remote cache avoids re-running unchanged tests but still analyzes the whole graph.",
    };
  }
  return undefined;
}

const skipsPullRequests = (subject: JobModel | StepModel): boolean =>
  subject.if !== undefined && NON_PR_CONDITION.test(subject.if);

export default defineRule({
  meta: {
    id: "affected/test-selection",
    ruleset: "affected",
    description: "Pull request CI in a monorepo should test only the projects affected by the change.",
    rationale:
      "Running every project's tests on every pull request makes CI time grow with the size of the repository instead of the size of the change. Agents open many small pull requests, so affected-only selection (nx affected, turbo --affected, pnpm `[ref]` filters, lerna --since) is the biggest lever for keeping feedback fast and runner minutes bounded.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nx.dev/docs/features/ci-features/affected",
      "https://turborepo.com/docs/reference/run#--affected",
      "https://pnpm.io/filtering#--filter-since",
      "https://lerna.js.org/docs/api-reference/commands#--since-ref",
      "https://yarnpkg.com/cli/workspaces/foreach",
    ],
    impact: "high",
    example: {
      bad: "on: pull_request\n...\n- run: npx nx run-many -t test",
      good: "on: pull_request\n...\n- uses: nrwl/nx-set-shas@v5\n- run: npx nx affected -t test",
    },
  },
  check({ project, report }) {
    if (!isKnownMonorepo(project)) return;
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !hasTrigger(workflow, "pull_request", "pull_request_target")) continue;
      for (const job of workflow.jobs) {
        if (skipsPullRequests(job)) continue;
        for (const entry of jobCommands(project, workflow, job)) {
          if (skipsPullRequests(entry.owner) || skipsPullRequests(entry.step)) continue;
          const finding = detect(project, entry.command);
          if (!finding) continue;
          report({
            path: entry.path,
            line: entry.line,
            key: `${entry.owner.key}:${finding.tool}`,
            message: `\`${finding.tool}\` runs ${finding.what} on every pull request instead of only what the change affects.`,
            suggestion: finding.suggestion,
          });
        }
      }
    }
  },
});
