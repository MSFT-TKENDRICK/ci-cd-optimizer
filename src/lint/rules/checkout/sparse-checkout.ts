import { posix } from "node:path";
import type { PackageManifest } from "../../parsers/manifest.js";
import type { StepModel } from "../../parsers/workflow.js";
import { commandsOf, defineRule, expandedJobSteps } from "../helpers.js";

const SHARED_DIRS = [".yarn", "patches", "config", "configs", "tools"];
const INSTALL =
  /^(?:(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|bun\s+install|yarn\s+install)(?:\s|$)|yarn(?:\s+--?[\w-]+(?:=\S+)?)*$)/;
const TRIVIAL =
  /^(?:echo|printf|cd|pushd|popd|export|set|unset|true|false|exit|sleep|ls|pwd|cat|mkdir|rm|cp|mv|touch|chmod|which|env|date|corepack|nvm|git\s+(?:config|status|log|rev-parse)|(?:npm|pnpm|yarn)\s+config|pnpm\s+store|[A-Za-z_][A-Za-z0-9_]*=)(?:\s|$)/;
/** Actions that do not read the working tree in a package-specific way. */
const NEUTRAL_ACTION =
  /^(?:actions\/(?:setup-|cache|upload-artifact|download-artifact|github-script)|pnpm\/action-setup|oven-sh\/setup-bun|nrwl\/nx-set-shas|denoland\/setup-deno|astral-sh\/setup-uv|docker\/(?:setup-|login-action))/;
/** Actions that analyze the whole repository and would silently lose coverage under a sparse checkout. */
const WHOLE_REPO_ACTION = /codeql-action|super-linter|megalinter|gitleaks|trufflehog|sonarsource|sonarqube/;
const PATH_INPUTS = ["working-directory", "working_directory", "workdir", "path", "context", "directory", "project", "root", "cwd"];

type Scope = { kind: "neutral" } | { kind: "package"; pkg: PackageManifest } | { kind: "unscoped" };

function cleanPath(path: string): string | undefined {
  if (path.includes("$") || path.startsWith("/") || path.startsWith("~")) return undefined;
  const normalized = posix.normalize(path).replace(/\/+$/, "");
  return normalized === ".." || normalized.startsWith("../") ? undefined : normalized || ".";
}

function joinPath(cwd: string | undefined, path: string): string | undefined {
  return cwd === undefined ? undefined : cleanPath(posix.join(cwd, path));
}

function packageAt(packages: PackageManifest[], path: string | undefined): PackageManifest | undefined {
  if (path === undefined) return undefined;
  return packages
    .filter((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

function resolveSelector(packages: PackageManifest[], raw: string): PackageManifest | undefined {
  if (/^(?:\^?\.\.\.|!)/.test(raw) || /[[\]*?]/.test(raw)) return undefined;
  const selector = raw.replace(/\^?\.\.\.$/, "").replace(/^\{(.*)\}$/, "$1");
  const byName = packages.filter((pkg) => pkg.name === selector);
  if (byName.length === 1) return byName[0];
  const dir = cleanPath(selector);
  const byDir = packages.find((pkg) => pkg.dir === dir);
  if (byDir || selector.includes("/")) return byDir;
  const byBase = packages.filter((pkg) => posix.basename(pkg.dir) === selector);
  return byBase.length === 1 ? byBase[0] : undefined;
}

/** Workspace selectors in a command; undefined when the command selects none. */
function selectorsOf(text: string): string[] | undefined {
  const found: string[] = [];
  const collect = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  };
  if (/\b(?:pnpm|turbo)\b/.test(text)) collect(/(?:^|\s)(?:--filter|-F)(?:=|\s+)(\S+)/g);
  if (/^(?:npm|npx)\s/.test(text)) collect(/(?:^|\s)(?:--workspace|-w)(?:=|\s+)(\S+)/g);
  if (/\blerna\b/.test(text)) collect(/(?:^|\s)--scope(?:=|\s+)(\S+)/g);
  collect(/\byarn\s+workspace\s+(\S+)/g);
  collect(/\bnx\s+run\s+([^\s:]+):/g);
  return found.length > 0 ? found : undefined;
}

function commandScope(packages: PackageManifest[], text: string, cwd: string | undefined): Scope {
  if (TRIVIAL.test(text) || INSTALL.test(text) || /\s--version$/.test(text)) return { kind: "neutral" };
  const selectors = selectorsOf(text);
  if (selectors) {
    const resolved = selectors.map((selector) => resolveSelector(packages, selector));
    const [first] = resolved;
    return first && resolved.every((pkg) => pkg === first) ? { kind: "package", pkg: first } : { kind: "unscoped" };
  }
  const pkg = packageAt(packages, cwd);
  return pkg ? { kind: "package", pkg } : { kind: "unscoped" };
}

function actionScope(packages: PackageManifest[], step: StepModel): Scope {
  const name = step.uses?.action.name ?? "";
  if (NEUTRAL_ACTION.test(name)) return { kind: "neutral" };
  if (WHOLE_REPO_ACTION.test(name)) return { kind: "unscoped" };
  const inputs = PATH_INPUTS.flatMap((key) => {
    const input = step.with.get(key);
    return input ? [input] : [];
  });
  if (inputs.length === 0) return { kind: "neutral" };
  const pkgs = inputs.map((input) =>
    input.kind === "literal" && typeof input.value === "string" ? packageAt(packages, cleanPath(input.value)) : undefined,
  );
  const [first] = pkgs;
  return first && pkgs.every((pkg) => pkg === first) ? { kind: "package", pkg: first } : { kind: "unscoped" };
}

function withDependencies(packages: PackageManifest[], root: PackageManifest): string[] {
  const byName = new Map(packages.flatMap((pkg) => (pkg.name ? [[pkg.name, pkg] as const] : [])));
  const seen = new Set<PackageManifest>([root]);
  const queue = [root];
  for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const dependency = byName.get(name);
      if (dependency && !seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...seen].map((pkg) => pkg.dir);
}

export default defineRule({
  meta: {
    id: "checkout/sparse-checkout",
    ruleset: "checkout",
    description: "Jobs that only work inside one workspace package of a large monorepo can use a sparse checkout.",
    rationale:
      "In large monorepos most of the checkout is files a package-scoped job never reads. A cone-mode sparse checkout of the package, its workspace dependencies, and shared config keeps checkout and disk usage proportional to the job, which adds up when agents trigger many small package-level runs.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["repository"],
    defaultOptions: { minWorkspacePackages: 3 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || !Number.isInteger(value) || value < 2)
        .map(([key]) => `${key} must be an integer of at least 2`),
    references: [
      "https://github.com/actions/checkout#fetch-only-a-single-file",
      "https://git-scm.com/docs/git-sparse-checkout#_internalscone_mode_handling",
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/checkout@v7\n- run: pnpm --filter web test",
      good: "- uses: actions/checkout@v7\n  with:\n    sparse-checkout: |\n      packages/web\n      packages/ui\n- run: pnpm --filter web test",
    },
  },
  check({ project, options, report }) {
    const { isMonorepo, workspacePackages } = project.facts;
    if (isMonorepo.status !== "known" || !isMonorepo.value || workspacePackages.status !== "known") return;
    const packages = workspacePackages.value;
    if (packages.length < options.minWorkspacePackages) return;
    const repoPaths = [...project.files.keys()];

    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        const expanded = expandedJobSteps(project, workflow, job);
        const checkouts = expanded.filter(({ step }) => step.uses?.action.name === "actions/checkout");
        const checkout = checkouts[0];
        if (checkouts.length !== 1 || !checkout?.direct || !checkout.step.uses) continue;
        if (["repository", "path", "sparse-checkout", "filter"].some((key) => checkout.step.with.has(key))) continue;

        const targets = new Set<PackageManifest>();
        const actionDirs = new Set<string>();
        let unscoped = false;
        let wholeInstall = false;
        for (const { step, direct } of expanded) {
          if (step === checkout.step) continue;
          const action = step.uses?.action;
          if (action?.kind === "local") {
            const dir = cleanPath(action.raw);
            if (dir === undefined) unscoped = true;
            else actionDirs.add(dir);
            continue;
          }
          if (action) {
            const scope = actionScope(packages, step);
            if (scope.kind === "unscoped") unscoped = true;
            if (scope.kind === "package") targets.add(scope.pkg);
            continue;
          }
          const base = direct ? (step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory) : step.workingDirectory;
          let cwd = cleanPath(base ?? ".");
          for (const { command } of commandsOf(step)) {
            const text = command.replace(/["']/g, "");
            if (text.startsWith("(")) unscoped = true;
            const cd = /^cd\s+(\S+)$/.exec(text);
            if (cd?.[1] !== undefined) cwd = cd[1] === "-" ? undefined : joinPath(cwd, cd[1]);
            if (INSTALL.test(text) && !/\s(?:--filter|-F|--workspace|-w)\b|\bfocus\b/.test(text)) wholeInstall = true;
            const scope = commandScope(packages, text, cwd);
            if (scope.kind === "unscoped") unscoped = true;
            if (scope.kind === "package") targets.add(scope.pkg);
          }
        }
        const [target] = targets;
        if (unscoped || !target || targets.size !== 1) continue;

        const dirs = [
          ...withDependencies(packages, target),
          ...actionDirs,
          ...SHARED_DIRS.filter((dir) => repoPaths.some((path) => path.startsWith(`${dir}/`))),
        ];
        const list = [...new Set(dirs)].map((dir) => `      ${dir}`).join("\n");
        const installNote = wholeInstall
          ? "\nThe job installs dependencies for the whole workspace, so scope the install too (for example `pnpm install --filter <name>...` or `yarn workspaces focus <name>`); other packages' manifests will be missing."
          : "";
        report({
          path: workflow.path,
          line: checkout.step.uses.line,
          key: `${checkout.step.key}.with.sparse-checkout`,
          message: `Job "${job.id}" checks out the whole monorepo but only works in ${target.dir}${target.name ? ` (${target.name})` : ""}.`,
          suggestion: `Check out only what the job needs; cone mode always includes root-level files such as package.json, lockfiles and tool configs:\n  with:\n    sparse-checkout: |\n${list}${installNote}`,
          confidence: "medium",
        });
      }
    }
  },
});
