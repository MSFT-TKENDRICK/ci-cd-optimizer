import type { JobModel, StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { commandsOf, defineRule, jobRunsOnLabels } from "../helpers.js";

const PRICING = "https://docs.github.com/en/billing/reference/actions-runner-pricing";

const STANDARD_RUNNERS: Record<string, string> = {
  "linux-x64": "ubuntu-latest",
  "linux-arm64": "ubuntu-24.04-arm",
  "windows-x64": "windows-latest",
  "windows-arm64": "windows-11-arm",
  macos: "macos-latest",
};

const LIGHT_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-python",
  "actions/setup-go",
  "actions/setup-java",
  "actions/setup-dotnet",
  "ruby/setup-ruby",
  "pnpm/action-setup",
  "oven-sh/setup-bun",
  "astral-sh/setup-uv",
  "actions/cache",
  "actions/cache/restore",
  "actions/labeler",
  "amannn/action-semantic-pull-request",
]);

const INFO_COMMANDS = new Set(["echo", "printf", "ls", "pwd", "date", "true", "uname", "whoami", "nproc", "df", "free"]);
const INSTALL = /^(npm (ci|install|i)|pnpm (install|i)|yarn( install)?|bun (install|i)|uv sync)(\s+--?[\w-]+(=\S+)?)*$/;
const LIGHT_TOOLS = new Set([
  "prettier",
  "biome",
  "@biomejs/biome",
  "actionlint",
  "shellcheck",
  "shfmt",
  "hadolint",
  "yamllint",
  "markdownlint",
  "markdownlint-cli",
  "markdownlint-cli2",
  "ruff",
  "black",
  "isort",
  "gofmt",
  "commitlint",
  "@commitlint/cli",
  "editorconfig-checker",
  "codespell",
  "typos",
]);
const RUNNER_PREFIX =
  /^(npx(\s+(--yes|-y))?|pnpm (exec|dlx)|yarn( dlx)?|bunx|uvx|pipx run|python3? -m|uv run|poetry run)\s+/;
const SCRIPT_RUN = /^(npm|pnpm|yarn|bun) run\s+([\w:.-]+)$|^(pnpm|yarn) ([\w:.-]+)$/;

function stripRunner(command: string): string {
  let current = command;
  for (let index = 0; index < 3; index += 1) {
    const next = current.replace(RUNNER_PREFIX, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

function lightTool(command: string): boolean {
  if (/[|><`]|\$\(/.test(command)) return false;
  const bare = stripRunner(command);
  if (/^git diff\b.*--exit-code\b/.test(bare)) return true;
  if (/^cargo fmt\b/.test(bare)) return true;
  const head = (bare.split(/\s+/)[0] ?? "").replace(/@[^/@]*$/, "");
  return LIGHT_TOOLS.has(head);
}

function informational(command: string): boolean {
  if (/[|><`]|\$\(/.test(command)) return false;
  const words = command.split(/\s+/);
  const head = words[0] ?? "";
  if (INFO_COMMANDS.has(head)) return true;
  return words.length === 2 && /^[a-z][\w.-]*$/.test(head) && /^(--version|version)$/.test(words[1] ?? "");
}

function scriptCommands(project: ProjectModel, name: string): string[] | undefined {
  const scripts = project.rootManifest?.json.scripts;
  if (!scripts || typeof scripts !== "object") return undefined;
  const script = (scripts as Record<string, unknown>)[name];
  return typeof script === "string" ? script.split(/&&|;/).map((part) => part.trim()).filter(Boolean) : undefined;
}

function lightCommand(project: ProjectModel, command: string, depth = 0): boolean {
  if (informational(command) || INSTALL.test(command) || lightTool(command)) return true;
  const script = SCRIPT_RUN.exec(command);
  const name = script?.[2] ?? script?.[4];
  if (!name || depth > 1 || ["install", "add", "dlx", "exec", "run"].includes(name)) return false;
  const commands = scriptCommands(project, name);
  return commands !== undefined && commands.length > 0 && commands.every((inner) => lightCommand(project, inner, depth + 1));
}

function lightStep(project: ProjectModel, step: StepModel): boolean {
  if (step.uses) {
    const action = step.uses.action;
    return action?.kind === "remote" && action.name !== undefined && LIGHT_ACTIONS.has(action.name);
  }
  if (step.workingDirectory !== undefined || (step.shell !== undefined && !/^(bash|sh|pwsh|powershell)$/.test(step.shell))) return false;
  const commands = commandsOf(step);
  return commands.length > 0 && commands.every(({ command }) => lightCommand(project, command));
}

interface LargerRunner {
  label: string;
  platform?: string;
  cores?: number;
  macos?: "large" | "xlarge";
}

function largerRunner(job: JobModel): LargerRunner | undefined {
  if (job.runsOn?.kind !== "literal") return undefined;
  const labels = jobRunsOnLabels(job);
  if (labels.length === 0 || labels.some((label) => /self-hosted|gpu|\$\{\{/i.test(label))) return undefined;
  for (const label of labels) {
    const macos = /^macos-[\w.]+-(large|xlarge)$/i.exec(label);
    if (macos) return { label, platform: "macos", macos: macos[1]?.toLowerCase() === "xlarge" ? "xlarge" : "large" };
    const cores = /(?:^|[-_.])(\d+)[-_]?cores?(?:$|[-_.])/i.exec(label);
    const count = Number(cores?.[1]);
    if (!cores || count < 4) continue;
    const os = /^(ubuntu|linux)/i.test(label) ? "linux" : /^windows/i.test(label) ? "windows" : undefined;
    const arch = /arm/i.test(label) ? "arm64" : "x64";
    return { label, ...(os ? { platform: `${os}-${arch}` } : {}), cores: count };
  }
  return undefined;
}

export default defineRule({
  meta: {
    id: "workflow/larger-runner-unjustified",
    ruleset: "workflow",
    description: "A job on a larger (multi-core or macOS large) runner that only checks out, sets up tools, installs and runs formatters or linters.",
    rationale:
      "A larger-looking runner label and familiar setup/lint commands do not establish resource needs or actual billing. Install hooks, native compilation, repository size, memory, networking and private runner policy can justify the selection. Compare representative end-to-end time, CPU/memory and current account pricing before downsizing. This is a measurement prompt, not proof of wasted cost.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: {},
    references: [
      PRICING,
      "https://docs.github.com/en/actions/reference/runners/larger-runners#machine-sizes-for-larger-runners",
      "https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/use-larger-runners",
    ],
    impact: "low",
    example: {
      bad: "format:\n  runs-on: ubuntu-24.04-16core\n  steps:\n    - uses: actions/checkout@v5\n    - run: npx prettier --check .",
      good: "format:\n  runs-on: ubuntu-latest\n  steps:\n    - uses: actions/checkout@v5\n    - run: npx prettier --check .",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        if (job.workingDirectory !== undefined || workflow.workingDirectory !== undefined) continue;
        if (job.uses || !job.runsOn || job.services.length > 0 || job.containerImage !== undefined || job.steps.length === 0) continue;
        const runner = largerRunner(job);
        if (!runner || !job.steps.every((step) => lightStep(project, step))) continue;
        const standard = runner.platform ? STANDARD_RUNNERS[runner.platform] : undefined;
        report({
          path: workflow.path,
          line: job.runsOn.line,
          key: `${job.key}.runs-on`,
          message: `Job \`${job.id}\` uses larger-looking runner label \`${runner.label}\` with recognized setup/install/format/lint commands. These names do not prove low CPU or memory use: installation hooks and native dependencies may be expensive. Measure before changing runner size.`,
          suggestion: `Benchmark a compatible standard runner${standard ? ` such as \`${standard}\`` : ""} against the current runner, preserving architecture, image, memory and networking requirements. Compare current account pricing (${PRICING}); keep the larger runner if its total cost, latency or required capabilities justify it.`,
          confidence: "low",
        });
      }
    }
  },
});
