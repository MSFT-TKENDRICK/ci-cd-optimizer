import { defineRule } from "../helpers.js";

export default defineRule({
  meta: {
    id: "hooks/install-in-hook",
    ruleset: "hooks",
    description: "Git hooks should not reinstall project dependencies on every invocation.",
    rationale: "A direct package-manager install in a commit/push hook repeats dependency resolution and potentially lifecycle scripts on the interactive path. Provision the same locked dependencies at setup and on lockfile changes, and fail explicitly when dependencies are absent. Do not remove secret scanning, linting or CI installation checks. No latency saving is guaranteed without measuring representative hooks.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended"],
    requires: [],
    defaultOptions: {},
    references: ["https://git-scm.com/docs/githooks", "https://docs.npmjs.com/cli/commands/npm-ci", "https://pre-commit.com/#new-hooks"],
    impact: "medium",
    fixable: false,
  },
  check({ project, report }) {
    for (const hook of project.hooks) {
      const [tool, subcommand] = hook.words;
      if (!tool || !subcommand || !["npm", "pnpm", "yarn", "bun"].includes(tool)) continue;
      if (!["install", "ci"].includes(subcommand)) continue;
      // A global or download-only operation is not a repeated project dependency install.
      if (hook.words.some((word) => ["-g", "--global", "--package-lock-only", "--lockfile-only"].includes(word))) continue;
      report({
        path: hook.path, line: hook.line, key: `install:${hook.line}`,
        message: `Hook command \`${hook.command}\` installs dependencies on the interactive Git path.`,
        suggestion: "Move this locked installation to documented developer setup and lockfile-change provisioning. Keep every mandatory hook check and make missing dependencies a blocking error; retain the clean install in CI.",
      });
    }
  },
});
