import type { JobModel, StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { commandsOf, defineRule, jobRunsOnLabels } from "../helpers.js";

const PRICING = "https://docs.github.com/en/billing/reference/actions-runner-pricing";

/** USD per minute, from the GitHub Actions runner pricing reference. */
const LARGER_PRICES: Record<string, Record<number, number>> = {
  "linux-x64": { 4: 0.012, 8: 0.022, 16: 0.042, 32: 0.082, 64: 0.162, 96: 0.252 },
  "windows-x64": { 4: 0.022, 8: 0.042, 16: 0.082, 32: 0.162, 64: 0.322, 96: 0.552 },
  "linux-arm64": { 4: 0.008, 8: 0.014, 16: 0.026, 32: 0.05, 64: 0.098 },
  "windows-arm64": { 4: 0.014, 8: 0.026, 16: 0.05, 32: 0.098, 64: 0.194 },
};
const STANDARD_PRICES: Record<string, { label: string; price: number; name: string }> = {
  "linux-x64": { label: "ubuntu-latest", price: 0.006, name: "Linux 2-core (x64)" },
  "linux-arm64": { label: "ubuntu-24.04-arm", price: 0.005, name: "Linux 2-core (arm64)" },
  "windows-x64": { label: "windows-latest", price: 0.01, name: "Windows 2-core (x64)" },
  "windows-arm64": { label: "windows-11-arm", price: 0.01, name: "Windows 2-core (arm64)" },
  macos: { label: "macos-latest", price: 0.062, name: "macOS 3-core or 4-core" },
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

function priceNote(runner: LargerRunner): string {
  const standard = runner.platform ? STANDARD_PRICES[runner.platform] : undefined;
  if (!standard) return "";
  const larger =
    runner.macos !== undefined
      ? runner.macos === "xlarge"
        ? { price: 0.102, name: "macOS 5-core (M2 Pro) `macos_xl`" }
        : { price: 0.077, name: "macOS 12-core `macos_l`" }
      : runner.cores !== undefined && runner.platform
        ? (() => {
            const price = LARGER_PRICES[runner.platform]?.[runner.cores];
            return price === undefined ? undefined : { price, name: `${runner.platform.replace("-", " ")} ${runner.cores}-core` };
          })()
        : undefined;
  if (!larger) return "";
  return ` If it is a GitHub-hosted ${larger.name} runner it bills $${larger.price}/min versus $${standard.price}/min for a standard ${standard.name} runner (${PRICING}), and larger runners are billed even for public repositories.`;
}

export default defineRule({
  meta: {
    id: "workflow/larger-runner-unjustified",
    ruleset: "workflow",
    description: "A job on a larger (multi-core or macOS large) runner that only checks out, sets up tools, installs and runs formatters or linters.",
    rationale:
      "Larger runners are billed per minute at a multiple of the standard rate and, unlike standard runners, are not free for public repositories. Checkout, toolchain setup, dependency installation and single-pass formatters/linters are dominated by network transfer and process start-up rather than CPU, so extra cores mostly add cost. GitHub also rounds every job up to a whole minute, so short jobs pay the larger per-minute rate for at least a full minute.",
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
        if (job.uses || !job.runsOn || job.services.length > 0 || job.containerImage !== undefined || job.steps.length === 0) continue;
        const runner = largerRunner(job);
        if (!runner || !job.steps.every((step) => lightStep(project, step))) continue;
        const standard = runner.platform ? STANDARD_PRICES[runner.platform] : undefined;
        report({
          path: workflow.path,
          line: job.runsOn.line,
          key: `${job.key}.runs-on`,
          message: `Job \`${job.id}\` runs on larger runner \`${runner.label}\` but only checks out, sets up tools, installs dependencies and runs formatters or linters, which gain little from extra cores.${priceNote(runner)}`,
          suggestion: `Run it on a standard runner:\n\nruns-on: ${standard?.label ?? "ubuntu-latest"}\n\nKeep the larger runner only if the job needs its static IP, private networking or extra memory.`,
        });
      }
    }
  },
});
