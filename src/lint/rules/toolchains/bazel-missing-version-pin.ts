import type { ProjectModel } from "../../project.js";
import type { Location } from "../../types.js";
import { basename, usesAction } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { commandDirectory, dirname, findUp, inDir, jobContexts, joinPath, words } from "./shared.js";

const WORKSPACE_FILES = ["MODULE.bazel", "WORKSPACE.bazel", "WORKSPACE"];
const SETUP_ACTIONS = ["bazel-contrib/setup-bazel", "bazelbuild/setup-bazelisk"];
/** Bazelisk labels that resolve to a different Bazel release over time. */
const FLOATING = /^(?:[\w.-]+\/)?(?:latest(?:-\d+)?|last_green|last_rc|rolling|\d+\.[x*])$/;

interface Use {
  path: string;
  line: number;
  dir: string;
  label: string;
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
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:export\s+)?USE_BAZEL_VERSION\s*=\s*["']?([^"'\s#]*)/.exec(lines[index] ?? "");
    if (match && match[1]) return { value: match[1], line: index + 1 };
  }
  return undefined;
}

function bazelversionValue(content: string): { value: string; line: number } | undefined {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const value = (lines[index] ?? "").trim();
    if (value !== "" && !value.startsWith("#")) return { value, line: index + 1 };
  }
  return undefined;
}

function mentions(project: ProjectModel, ...texts: string[]): boolean {
  return [...project.workflows, ...project.actions].some((workflow) => {
    const content = project.files.get(workflow.path)?.content ?? "";
    return texts.some((text) => content.includes(text));
  });
}

export default defineRule({
  meta: {
    id: "toolchains/bazel-missing-version-pin",
    ruleset: "toolchains",
    description: "Bazel workspaces built in CI should pin the Bazel version in a checked-in `.bazelversion` file.",
    rationale:
      "Bazelisk (pre-installed on GitHub-hosted runners and used by bazel-contrib/setup-bazel) picks the Bazel version from `USE_BAZEL_VERSION`, then `.bazeliskrc`, then `.bazelversion`; with none of them, or with a label such as `latest`, `rolling` or `7.x`, it runs whatever release is newest when the job starts. A new release can bring backward-incompatible changes between major versions and changes the Bazel binary every action runs under, so CI results can change without any commit, and setup-bazel's `bazelisk-cache`, keyed on `.bazelversion`, cannot follow the version. The Bazel docs recommend checking `.bazelversion` into version control to make builds reproducible.",
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
    if (mentions(project, "USE_BAZEL_VERSION", "USE_BAZEL_FALLBACK_VERSION")) return;
    const uses: Use[] = [];
    for (const ctx of jobContexts(project)) {
      for (const entry of ctx.entries) {
        if (!usesAction(entry.step, ...SETUP_ACTIONS)) continue;
        const moduleRoot = entry.step.with.get("module-root");
        if (moduleRoot && (moduleRoot.kind !== "literal" || typeof moduleRoot.value !== "string")) continue;
        const dir = joinPath("", typeof moduleRoot?.value === "string" ? moduleRoot.value : ".");
        const action = entry.step.uses?.value ?? "setup-bazel";
        if (dir !== undefined) uses.push({ path: entry.path, line: entry.step.line, dir, label: `uses: ${action}` });
      }
      for (const command of ctx.commands) {
        const first = words(command.command)[0];
        if (first === undefined || !["bazel", "bazelisk"].includes(basename(first))) continue;
        const dir = commandDirectory(ctx, command);
        if (dir !== undefined) uses.push({ path: command.path, line: command.line, dir, label: command.command.trim() });
      }
    }
    const reported = new Set<string>();
    for (const use of uses) {
      const root = workspaceRoot(project, use.dir);
      if (root === undefined || reported.has(root)) continue;
      reported.add(root);
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
          key: `bazel-root:${root}`,
          message: `\`${pinPath}\` selects the floating Bazel label \`${pinned.value}\` for ${where}, so Bazelisk runs a different Bazel release whenever a new one matching it is published and CI behaviour can change without a commit.`,
          suggestion: `Pin an exact release instead, for example the one CI uses today (\`bazel --version\` prints it):\n\n${rc ? "USE_BAZEL_VERSION=<version>" : "<version>"}\n\nUpgrade deliberately by changing this file in a pull request (Renovate and Dependabot-style tools can propose the bumps).`,
          confidence: /^(?:[\w.-]+\/)?\d+\.[x*]$/.test(pinned.value) ? "medium" : "high",
          related: [{ path: use.path, line: use.line }, ...related],
        });
        continue;
      }
      report({
        path: use.path,
        line: use.line,
        key: `bazel-root:${root}`,
        message: `${Where} has no \`.bazelversion\`, no \`USE_BAZEL_VERSION\` in \`.bazeliskrc\` and no \`USE_BAZEL_VERSION\` in the workflow environment, so \`${use.label}\` runs whichever Bazel release is the latest when the job starts.`,
        suggestion: `Commit \`${target}\` containing the exact Bazel release CI should use (\`bazel --version\` prints the one it resolves today), for example:\n\n8.4.2\n\nBazelisk then downloads exactly that release, local and CI builds use the same Bazel, and upgrades happen in reviewed pull requests.`,
        related,
      });
    }
  },
});
