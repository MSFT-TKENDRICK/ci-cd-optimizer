import { defineRule } from "../helpers.js";
import { SETUP_ACTIONS, nestedPair, rawScalar, setupActionOf, stepNode } from "./shared.js";

interface Use {
  path: string;
  line: number;
  version: string;
}

/** Literal version as written (`v20`, `20.x`, `"3.10"`), reduced to dotted numbers; undefined for aliases like `lts/*`. */
function normalize(raw: string): string | undefined {
  const version = raw.trim().replace(/^v/i, "").replace(/(?:\.[x*])+$/i, "");
  return /^\d+(?:\.\d+)*$/.test(version) ? version : undefined;
}

/** `20` and `20.11` can resolve to the same toolchain; `20` and `22` cannot. */
function compatible(a: string, b: string): boolean {
  const left = a.split(".");
  const right = b.split(".");
  return left.slice(0, right.length).join(".") === right.slice(0, left.length).join(".");
}

function conflicting(versions: string[]): boolean {
  return versions.some((a, index) => versions.slice(index + 1).some((b) => !compatible(a, b)));
}

const VERSION_FILES: Record<string, string> = {
  "actions/setup-node": "`.nvmrc` or `.node-version` (`node-version-file`)",
  "actions/setup-python": "`.python-version` (`python-version-file`)",
  "actions/setup-go": "`go.mod` (`go-version-file`)",
  "actions/setup-java": "`.java-version` or `.sdkmanrc` (`java-version-file`)",
  "actions/setup-dotnet": "`global.json` (`global-json-file`)",
  "oven-sh/setup-bun": "`.bun-version` (`bun-version-file`)",
  "ruby/setup-ruby": "`.ruby-version` (omit `ruby-version`)",
  "pnpm/action-setup": "the `packageManager` field in package.json (omit `version`)",
};

export default defineRule({
  meta: {
    id: "redundancy/toolchain-version-drift",
    ruleset: "redundancy",
    description: "Workflows should agree on the toolchain version they install with each setup action.",
    rationale:
      "When one workflow installs Node 20 and another Node 22, or Python 3.11 versus 3.12, CI validates on one runtime and releases on another. These pins are usually updated one file at a time, so they drift. A single version file read by every setup step keeps them aligned. This covers language toolchains installed by setup actions, not package dependency versions.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#node-version-file"],
    impact: "medium",
    example: {
      bad: "# ci.yml\n- uses: actions/setup-node@v4\n  with:\n    node-version: 20\n# release.yml\n- uses: actions/setup-node@v4\n  with:\n    node-version: 22",
      good: "# ci.yml and release.yml\n- uses: actions/setup-node@v4\n  with:\n    node-version-file: .nvmrc",
    },
  },
  check({ project, report }) {
    const byInput = new Map<string, Map<string, Use[]>>();
    for (const workflow of [...project.workflows, ...project.actions]) {
      const file = project.files.get(workflow.path);
      if (!file) continue;
      for (const job of workflow.jobs) {
        if (job.uses || job.matrix !== undefined) continue;
        for (const step of job.steps) {
          const action = setupActionOf(step);
          const setup = action ? SETUP_ACTIONS[action] : undefined;
          if (!action || !setup?.version) continue;
          if (setup.versionFiles?.some((input) => step.with.has(input))) continue;
          const entry = step.with.get(setup.version);
          if (!entry || entry.kind !== "literal" || entry.origin !== "direct") continue;
          const pair = nestedPair(stepNode(workflow, step), "with", setup.version);
          const raw = pair ? rawScalar(file.content, pair.pair.value) : undefined;
          const version = raw === undefined ? undefined : normalize(raw);
          if (version === undefined) continue;
          const key = `${action}\u0000${setup.version}`;
          const files = byInput.get(key) ?? new Map<string, Use[]>();
          const uses = files.get(workflow.path) ?? [];
          uses.push({ path: workflow.path, line: entry.line, version });
          files.set(workflow.path, uses);
          byInput.set(key, files);
        }
      }
    }
    for (const [key, files] of byInput) {
      const [action = "", input = ""] = key.split("\u0000");
      // A file that already installs several incompatible versions is deliberately testing more than one.
      const uses = [...files.values()].filter((entries) => !conflicting(entries.map((use) => use.version))).flat();
      const versions = [...new Set(uses.map((use) => use.version))];
      if (new Set(uses.map((use) => use.path)).size < 2 || !conflicting(versions)) continue;
      const [first, ...others] = uses;
      if (!first) continue;
      const hint = VERSION_FILES[action] ?? "a shared version file";
      report({
        path: first.path,
        line: first.line,
        key: `${action}.${input}`,
        message: `${action} \`${input}\` differs across workflows: ${versions.join(", ")}.`,
        suggestion: `Pick one version and read it from ${hint} in every workflow.`,
        confidence: "medium",
        related: others.map((use) => ({ path: use.path, line: use.line })),
      });
    }
  },
});
