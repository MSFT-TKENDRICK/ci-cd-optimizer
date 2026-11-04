import { fix, replaceOnLine } from "../../fix.js";
import { commandsOf, defineRule, steps } from "../helpers.js";

const SAFE_NPM_FLAGS = new Set(["--no-audit", "--no-fund", "--prefer-offline", "--ignore-scripts", "--legacy-peer-deps", "--loglevel=error", "--silent"]);

export default defineRule({
  meta: {
    id: "hermeticity/frozen-lockfile",
    ruleset: "hermeticity",
    description: "CI installs must be locked to the committed lockfile.",
    rationale:
      "`npm install` and unfrozen yarn/bun installs can rewrite the lockfile and resolve different versions per run, which breaks reproducibility and cache keys. Frozen installs are also faster.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.npmjs.com/cli/v11/commands/npm-ci",
      "https://classic.yarnpkg.com/en/docs/cli/install#toc-yarn-install-frozen-lockfile",
      "https://pnpm.io/cli/install#--frozen-lockfile",
    ],
    impact: "medium",
    fixable: true,
    example: { bad: "- run: npm install", good: "- run: npm ci" },
  },
  check({ project, report }) {
    const facts = project.facts;
    const npmLock = facts.lockfiles.some((path) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path));
    const yarnLock = project.files.get("yarn.lock");
    const yarnClassic =
      (typeof project.rootManifest?.json.packageManager === "string" && project.rootManifest.json.packageManager.startsWith("yarn@1")) ||
      (yarnLock?.content.includes("# yarn lockfile v1") ?? false);
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      const file = project.files.get(workflow.path);
      for (const { command, line } of commandsOf(step)) {
        const words = command.split(/\s+/);
        const [tool, verb, ...rest] = words;
        if (tool === "npm" && (verb === "install" || verb === "i")) {
          if (rest.some((arg) => arg === "-g" || arg === "--global")) continue;
          const packages = rest.filter((arg) => !arg.startsWith("-"));
          if (packages.length > 0) continue;
          const fixable = npmLock && rest.every((arg) => SAFE_NPM_FLAGS.has(arg)) && file !== undefined;
          report({
            path: workflow.path,
            line,
            key: `${step.key}:npm-install`,
            message: "`npm install` can modify package-lock.json and resolve different versions in CI.",
            suggestion: npmLock ? "Use `npm ci`." : "Commit package-lock.json and use `npm ci`.",
            confidence: npmLock ? "high" : "medium",
            ...(fixable ? { fix: fix("Use npm ci", replaceOnLine(file, line, `npm ${verb}`, "npm ci")) } : {}),
          });
        } else if (tool === "yarn" && (verb === undefined || verb === "install") && yarnClassic) {
          if (rest.includes("--frozen-lockfile") || rest.includes("--immutable")) continue;
          report({
            path: workflow.path,
            line,
            key: `${step.key}:yarn-install`,
            message: "Yarn classic install without `--frozen-lockfile` can update yarn.lock in CI.",
            suggestion: "Use `yarn install --frozen-lockfile`.",
          });
        } else if (tool === "pnpm" && (verb === "install" || verb === "i") && rest.includes("--no-frozen-lockfile")) {
          report({
            path: workflow.path,
            line,
            key: `${step.key}:pnpm-install`,
            message: "`pnpm install --no-frozen-lockfile` disables pnpm's CI lockfile protection.",
            suggestion: "Remove `--no-frozen-lockfile` (pnpm freezes the lockfile in CI by default).",
          });
        } else if (tool === "bun" && verb === "install" && !rest.includes("--frozen-lockfile")) {
          report({
            path: workflow.path,
            line,
            key: `${step.key}:bun-install`,
            message: "`bun install` without `--frozen-lockfile` can update the lockfile in CI.",
            suggestion: "Use `bun install --frozen-lockfile`.",
          });
        }
      }
    }
  },
});
