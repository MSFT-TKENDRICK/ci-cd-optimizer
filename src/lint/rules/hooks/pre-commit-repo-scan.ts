import { defineRule } from "../helpers.js";

export default defineRule({
  meta: {
    id: "hooks/pre-commit-repo-scan",
    ruleset: "hooks",
    description: "Explicit whole-repository pre-commit lint entries should not also receive batched filenames.",
    rationale: "pre-commit appends matching filenames by default and may split them across invocations to fit command-line limits. An entry that explicitly scans `.` can consequently repeat a whole-repository scan per batch. For intentionally whole-repository checks, pass_filenames: false avoids redundant arguments and batches without reducing analysis scope. Keep file filters, mandatory checks and CI gates; do not apply this advice to staged-file-only linters.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended"],
    requires: [],
    defaultOptions: {},
    references: ["https://pre-commit.com/#hooks-pass_filenames", "https://pre-commit.com/#creating-new-hooks"],
    impact: "medium",
    fixable: false,
  },
  check({ project, report }) {
    for (const hook of project.hooks) {
      if (hook.passFilenames !== true) continue;
      const [tool, ...args] = hook.words;
      if (!["eslint", "prettier", "cicd-lint"].includes(tool ?? "")) continue;
      const flags = new Set(["--check", "--write", "--fix", "--quiet", "--cache"]);
      if (args.filter((arg) => !flags.has(arg)).join("\0") !== ".") continue;
      // pre-commit executes argv, not shell; wrappers, dynamic syntax and extra commands are opaque.
      if (/[;&|$`]/.test(hook.command) || args.includes("--")) continue;
      report({
        path: hook.path, line: hook.line, key: `repo-scan:${hook.line}`,
        message: `Pre-commit entry \`${hook.command}\` explicitly scans \`.\` and also receives filenames by default; filename batches can repeat the repository scan.`,
        suggestion: "Set pass_filenames: false for this whole-repository entry. Preserve its files/types filters and all mandatory checks. Do not replace repository-wide analysis with staged-only analysis.",
      });
    }
  },
});
