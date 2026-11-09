import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule } from "../helpers.js";
import { hash, setupActionOf, stepSignature } from "./shared.js";

const INSTALL =
  /^(?:npm (?:ci|install|i)|pnpm (?:install|i)|yarn(?: install)?|bun install|pip3? install|python3? -m pip install|poetry install|uv sync|bundle install|go mod download|composer install|dotnet restore)\b/;

interface Candidate {
  workflow: WorkflowModel;
  job: JobModel;
  signatures: string[];
}

function isSetup(step: StepModel): boolean {
  if (setupActionOf(step)) return true;
  const name = step.uses?.action?.name ?? "";
  if (/\/setup-|\/action-setup$/.test(name)) return true;
  return commandsOf(step).some(({ command }) => INSTALL.test(commandWords(command).join(" ")));
}

function commonPrefix(candidates: Candidate[]): number {
  let length = 0;
  const [first, ...rest] = candidates;
  if (!first) return 0;
  while (length < first.signatures.length && rest.every((entry) => entry.signatures[length] === first.signatures[length])) length += 1;
  return length;
}

export default defineRule({
  meta: {
    id: "redundancy/repeated-job-setup",
    ruleset: "redundancy",
    description: "Jobs that repeat the same leading setup steps could share a composite action.",
    rationale:
      "When many jobs open with the same checkout, toolchain, and install steps, every change to that setup (a new cache key, an action upgrade, a registry login) has to be made in each copy. Copies drift, and drifted setup is a common source of 'works in one job, fails in another'. A local composite action keeps one definition.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: { minJobs: 3, minSteps: 3 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || !Number.isInteger(value) || value < 2)
        .map(([key]) => `${key} must be an integer of at least 2`),
    references: ["https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action"],
    impact: "low",
    example: {
      bad: "jobs:\n  lint:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: npm ci\n      - run: npm run lint\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: npm ci\n      - run: npm test\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: npm ci\n      - run: npm run build",
      good: "jobs:\n  lint:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./.github/actions/setup\n      - run: npm run lint",
    },
  },
  check({ project, options, report }) {
    const minJobs = Number(options.minJobs);
    const minSteps = Number(options.minSteps);
    const groups = new Map<string, Candidate[]>();
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        if (job.uses || job.steps.length < minSteps) continue;
        const signatures = job.steps.map((step) => stepSignature(workflow, job, step));
        const key = signatures.slice(0, minSteps).join("\u0001");
        const group = groups.get(key) ?? [];
        group.push({ workflow, job, signatures });
        groups.set(key, group);
      }
    }
    for (const group of groups.values()) {
      if (group.length < minJobs) continue;
      const [first, ...others] = group;
      if (!first) continue;
      const length = commonPrefix(group);
      const prefix = first.job.steps.slice(0, length);
      if (prefix.some((step) => step.uses?.action?.kind === "local" || step.uses?.action?.kind === "expression")) continue;
      if (!prefix.some(isSetup)) continue;
      // Jobs whose entire step list is the shared prefix are duplicates, not shared setup.
      if (group.every((entry) => entry.job.steps.length === length)) continue;
      const jobs = group.map((entry) => (entry.workflow === first.workflow ? entry.job.id : `${entry.workflow.path}#${entry.job.id}`));
      report({
        path: first.workflow.path,
        line: first.job.line,
        key: `${first.job.key}.repeated-setup.${hash(first.signatures.slice(0, length).join("\u0001"))}`,
        message: `${group.length} jobs start with the same ${length} setup steps (${jobs.join(", ")}).`,
        suggestion:
          "Move the shared steps into a composite action under `.github/actions/<name>/action.yml` and call it with `uses: ./.github/actions/<name>` after checkout.",
        confidence: "medium",
        related: others.map((entry) => ({ path: entry.workflow.path, line: entry.job.line })),
      });
    }
  },
});
