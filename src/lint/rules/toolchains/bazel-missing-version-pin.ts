import type { ProjectModel } from "../../project.js";
import type { Location } from "../../types.js";
import { basename, usesAction } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { commandDirectory, dirname, effectiveEnv, entryIndex, findUp, inDir, jobContexts, toolCommands } from "./shared.js";

const WORKSPACE_FILES = ["MODULE.bazel", "WORKSPACE.bazel", "WORKSPACE"];
const SETUP_ACTIONS = ["bazel-contrib/setup-bazel", "bazelbuild/setup-bazelisk"];
/** Bazelisk labels that resolve to a different Bazel release over time. */
const FLOATING = /^(?:[\w.-]+\/)?(?:latest(?:-\d+)?|last_green|last_rc|rolling|\d+\.[x*])$/;

interface Use {
  path: string;
  line: number;
  dir: string;
  label: string;
  scope: string;
}

function workspaceRoot(project: ProjectModel, dir: string): string | undefined {
  let current: string | undefined = dir;
  while (current !== undefined) {
    const here = current;
    if (WORKSPACE_FILES.some((name) => project.files.has(inDir(here, name)))) return here;
    current = current === "" ? undefined : dirname(current);
  }
  return undefined;
}

/** `USE_BAZEL_VERSION` from a `.bazeliskrc` (`KEY=value` lines). */
function bazeliskrcVersion(content: string): { value: string; line: number } | undefined {
  const lines = content.split("\n");
  let result: { value: string; line: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:export\s+)?USE_BAZEL_VERSION\s*=\s*["']?([^"'\s#]*)/.exec(lines[index] ?? "");
    if (match && match[1]) result = result ? { value: "${unknown}", line: index + 1 } : { value: match[1], line: index + 1 };
  }
  return result;
}

function bazelversionValue(content: string): { value: string; line: number } | undefined {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const value = (lines[index] ?? "").trim();
    if (value !== "" && !value.startsWith("#")) return { value, line: index + 1 };
  }
  return undefined;
}

export default defineRule({
  meta: {
    id: "toolchains/bazel-missing-version-pin",
    ruleset: "toolchains",
    description: "Bazel workspaces built in CI should pin the Bazel version in a checked-in `.bazelversion` file.",
    rationale:
      "Bazelisk resolves Bazel using its environment/configuration and version file. Without a visible choice, its fallback can track newer releases; floating labels intentionally do so. Plain Bazel does not select versions this way, so only explicit bazelisk commands or bazel commands after a recognized Bazelisk setup are considered. External configuration, cache state and installer versions can change resolution. An exact reviewed release constrains the tool version, not whole-build reproducibility.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://github.com/bazelbuild/bazelisk#how-does-bazelisk-know-which-bazel-version-to-run",
      "https://bazel.build/install/bazelisk",
      "https://github.com/bazel-contrib/setup-bazel#bazelisk-cache",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "# MODULE.bazel present, no .bazelversion\n- uses: bazel-contrib/setup-bazel@0.19.1\n- run: bazel test //...",
      good: "# .bazelversion\n8.4.2\n\n# workflow\n- uses: bazel-contrib/setup-bazel@0.19.1\n- run: bazel test //...",
    },
  },
  check({ project, report }) {
    const uses: Use[] = [];
    for (const ctx of jobContexts(project)) {
      for (const { command, words: list } of toolCommands(ctx, "bazel", "bazelisk")) {
        const env = effectiveEnv(ctx, command, command);
        if (env.has("USE_BAZEL_VERSION") || env.has("USE_BAZEL_FALLBACK_VERSION")) continue;
        const prior = ctx.entries.slice(0, entryIndex(ctx, command));
        if (basename(list[0] ?? "") !== "bazelisk" &&
            !prior.some(({ step, owner }) => !step.if && !owner.if && usesAction(step, ...SETUP_ACTIONS))) continue;
        if (!list.some((word) => ["build", "test", "run", "coverage", "query", "cquery", "aquery"].includes(word))) continue;
        const dir = commandDirectory(ctx, command);
        if (dir !== undefined) uses.push({ path: command.path, line: command.line, dir, label: command.command.trim(), scope: `${ctx.workflow.path}:${ctx.job.id}` });
      }
    }
    const reported = new Set<string>();
    for (const use of uses) {
      const root = workspaceRoot(project, use.dir);
      if (root === undefined || reported.has(`${root}:${use.scope}`)) continue;
      reported.add(`${root}:${use.scope}`);
      const workspaceFile = WORKSPACE_FILES.map((name) => inDir(root, name)).find((path) => project.files.has(path)) ?? inDir(root, "MODULE.bazel");
      const where = root === "" ? "the root Bazel workspace" : `the Bazel workspace in \`${root}/\``;
      const Where = root === "" ? "The root Bazel workspace" : `The Bazel workspace in \`${root}/\``;
      const target = inDir(root, ".bazelversion");
      const rcPath = findUp(project, use.dir, ".bazeliskrc");
      const rc = rcPath ? bazeliskrcVersion(project.files.get(rcPath)?.content ?? "") : undefined;
      const versionPath = findUp(project, use.dir, ".bazelversion");
      const pinned = rc ?? (versionPath ? bazelversionValue(project.files.get(versionPath)?.content ?? "") : undefined);
      const pinPath = rc && rcPath ? rcPath : versionPath;
      const related: Location[] = [{ path: workspaceFile, line: 1 }];
      if (pinned && pinPath) {
        if (!FLOATING.test(pinned.value)) continue;
        report({
          path: pinPath,
          line: pinned.line,
          key: `bazel-root:${root}:${use.scope}`,
          message: `\`${pinPath}\` selects the floating Bazel label \`${pinned.value}\` for ${where}. Under standard Bazelisk resolution this may select a newer release without a repository change; external configuration and caches can affect the actual version.`,
          suggestion: `Pin an exact release instead, for example the one CI uses today (\`bazel --version\` prints it):\n\n${rc ? "USE_BAZEL_VERSION=<version>" : "<version>"}\n\nUpgrade deliberately by changing this file in a pull request (Renovate and Dependabot-style tools can propose the bumps).`,
          confidence: /^(?:[\w.-]+\/)?\d+\.[x*]$/.test(pinned.value) ? "medium" : "high",
          related: [{ path: use.path, line: use.line }, ...related],
        });
        continue;
      }
      report({
        path: use.path,
        line: use.line,
        key: `bazel-root:${root}:${use.scope}`,
        message: `${Where} has no \`.bazelversion\`, no \`USE_BAZEL_VERSION\` in the inspected \`.bazeliskrc\` and no visible version/fallback environment setting for \`${use.label}\`. Standard Bazelisk fallback may choose a newer release; inspect external configuration before adding a pin.`,
        suggestion: `If a fixed release is intended, record the reviewed version in \`${target}\` and verify the actual Bazelisk precedence and runtime version. For example, a version file can contain \`8.4.2\`; choose the release supported by this project, not the example blindly. Upgrade and test deliberately.`,
        confidence: "medium",
        related,
      });
    }
  },
});
