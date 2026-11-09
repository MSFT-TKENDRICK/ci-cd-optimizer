import { isScalar, type Node } from "yaml";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, items, lineOfNode } from "../../parsers/yaml.js";
import type { ProjectModel } from "../../project.js";
import { commandsOf, defineRule, isDeployLike, jobRunsOnLabels } from "../helpers.js";

const DEPLOY = /deploy|release|publish|promote|rollout|ship/i;
/** Jobs whose name suggests they gate later jobs on success (even without outputs) are never reported. */
const GATE =
  /test|lint|build|check|verify|validat|typecheck|compile|scan|audit|\bci\b|e2e|smoke|format|fmt|analy|codeql|security|review|approv|gate|guard|preflight|sanity|wait|lock|migrat|provision|setup-env|infra/i;
const STANDARD_RUNNER = /^(ubuntu|windows|macos)-(latest|\d[\w.]*)(-arm|-intel)?$/;
const SETUP_ACTIONS = new Set([
  "actions/setup-node",
  "actions/setup-python",
  "actions/setup-go",
  "actions/setup-java",
  "actions/setup-dotnet",
  "ruby/setup-ruby",
]);
const INFO_COMMANDS = new Set(["echo", "printf", "cat", "ls", "pwd", "date", "true", "uname", "whoami", "df", "nproc", "free"]);
const INSTALL =
  /^(npm (ci|install|i)|pnpm (install|i)|yarn( install)?|bun (install|i)|pip3? install|python3? -m pip install|bundle install|go mod download|dotnet restore|composer install|poetry install|uv sync)(\s|$)/;

function jobNode(workflow: WorkflowModel, job: JobModel): Node | null | undefined {
  const source = workflow.source;
  return field(source, field(source, source.doc.contents, "jobs")?.value, job.id)?.value;
}

function jobText(project: ProjectModel, workflow: WorkflowModel, job: JobModel): string {
  const node = jobNode(workflow, job);
  const content = project.files.get(workflow.path)?.content ?? "";
  return node?.range ? content.slice(node.range[0], node.range[1]) : content;
}

function informational(command: string): boolean {
  if (/\$\(|`|<\(/.test(command)) return false;
  const words = command.split(/\s+/);
  const head = words[0] ?? "";
  if (head === "env" || head === "printenv") return words.length === 1;
  if (INFO_COMMANDS.has(head)) return !/[>|]/.test(command) || /^echo\b[^>|]*>>\s*"?\$\{?GITHUB_STEP_SUMMARY\}?"?$/.test(command);
  return words.length === 2 && /^[a-z][\w.-]*$/.test(head) && /^(--version|version)$/.test(words[1] ?? "");
}

/** Why a step has no effect another job could observe; undefined when it might (artifacts, caches, side effects). */
function inertStep(project: ProjectModel, step: StepModel): string | undefined {
  const action = step.uses?.action;
  if (step.uses) {
    if (action?.kind !== "remote" || action.name === undefined) return undefined;
    if (action.name === "actions/checkout") return "checkout";
    if (!SETUP_ACTIONS.has(action.name)) return undefined;
    const cache = step.with.get("cache") ?? step.with.get("bundler-cache");
    if (action.name === "actions/setup-go") return cache && /^false$/i.test(String(cache.value)) ? "setup" : undefined;
    if (cache && !/^false$/i.test(String(cache.value))) return undefined;
    if (action.name === "actions/setup-node" && !/^false$/i.test(String(step.with.get("package-manager-cache")?.value))) {
      const json = project.rootManifest?.json;
      if (json && (json.packageManager !== undefined || json.devEngines !== undefined)) return undefined;
    }
    return "setup";
  }
  const commands = commandsOf(step);
  if (commands.length === 0) return undefined;
  if (commands.every(({ command }) => informational(command))) return "echo";
  if (commands.every(({ command }) => informational(command) || INSTALL.test(command))) return "install";
  return undefined;
}

function needsLine(workflow: WorkflowModel, job: JobModel, dependency: string): number {
  const source = workflow.source;
  const needs = field(source, jobNode(workflow, job), "needs");
  if (!needs) return job.line;
  const item = items(source, needs.value).find((node) => isScalar(node) && String(node.value) === dependency);
  return item ? lineOfNode(source, item) : needs.line;
}

function standardHosted(job: JobModel): boolean {
  if (job.runsOn?.kind !== "literal") return false;
  const labels = jobRunsOnLabels(job);
  return labels.length === 1 && STANDARD_RUNNER.test(labels[0] ?? "");
}

export default defineRule({
  meta: {
    id: "workflow/unnecessary-needs-serialization",
    ruleset: "workflow",
    description:
      "A `needs` edge on a job that produces nothing the dependent job can use only delays the dependent job.",
    rationale:
      "Every job runs on a fresh runner, so files, installed dependencies and environment changes from one job are invisible to the next; only job outputs, artifacts and caches cross the boundary. When job A has no outputs, uploads nothing, saves no cache and only checks out, sets up toolchains, installs dependencies or prints information, `needs: A` cannot pass anything to B. B still waits for A's queue time, runner start-up and steps, which lengthens the critical path of every run.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds",
      "https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs",
      "https://docs.github.com/en/actions/tutorials/store-and-share-data",
    ],
    impact: "medium",
    example: {
      bad: "jobs:\n  setup:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n  unit:\n    needs: setup\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci && npm test",
      good: "jobs:\n  unit:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci && npm test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || isDeployLike(workflow)) continue;
      const source = workflow.source;
      for (const job of workflow.jobs) {
        if (job.needs.length === 0 || job.environment !== undefined || DEPLOY.test(`${job.id} ${job.name ?? ""}`)) continue;
        if (job.if !== undefined && /needs|always\(\)|failure\(\)|cancelled\(\)|success\(\)/.test(job.if)) continue;
        const text = jobText(project, workflow, job);
        if (/\bneeds\b\s*[),}]/.test(text)) continue;
        for (const dependency of job.needs) {
          const upstream = workflow.jobs.find((candidate) => candidate.id === dependency);
          if (!upstream || upstream.uses || upstream.if !== undefined || upstream.concurrency || upstream.environment) continue;
          if (GATE.test(`${upstream.id} ${upstream.name ?? ""}`) || !standardHosted(upstream)) continue;
          if (upstream.services.length > 0 || upstream.steps.length === 0) continue;
          if (field(source, jobNode(workflow, upstream), "outputs")) continue;
          const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (new RegExp(`needs\\s*(\\.\\s*${escaped}\\b|\\[\\s*['"]${escaped}['"]\\s*\\])`).test(text)) continue;
          const kinds = upstream.steps.map((step) => inertStep(project, step));
          if (kinds.some((kind) => kind === undefined)) continue;
          const remaining = job.needs.filter((need) => need !== dependency);
          const did = [...new Set(kinds)]
            .map((kind) => ({ checkout: "checks out", setup: "sets up a toolchain", install: "installs dependencies", echo: "prints information" })[kind ?? "echo"])
            .join(", ");
          report({
            path: workflow.path,
            line: needsLine(workflow, job, dependency),
            key: `${job.key}.needs.${dependency}`,
            message: `Job \`${job.id}\` needs \`${dependency}\`, but \`${dependency}\` only ${did} and has no outputs, artifacts or caches, so nothing it does reaches \`${job.id}\` (jobs run on separate runners); consider removing the edge so both start in parallel.`,
            suggestion: `${
              remaining.length === 0
                ? `Remove \`needs: ${dependency}\` from \`${job.id}\``
                : `Use \`needs: [${remaining.join(", ")}]\` in \`${job.id}\``
            }. If \`${dependency}\` exists to prepare dependencies for \`${job.id}\`, it has to share them explicitly, e.g. with \`actions/cache\` keyed on the lockfile or \`actions/upload-artifact\`; otherwise drop the job.`,
          });
        }
      }
    }
  },
});
