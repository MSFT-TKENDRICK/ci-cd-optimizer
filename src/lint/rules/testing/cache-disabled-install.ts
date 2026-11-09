import type { StepModel } from "../../parsers/workflow.js";
import { defineRule, jobCommands, stepLine } from "../helpers.js";
import { cacheCovers, usesAction } from "../caching/shared.js";
import { toolWords } from "./shared.js";

type Ecosystem = "npm" | "yarn" | "pnpm" | "pip";

const TEMP_CACHE = /^(?:\/tmp|\/var\/tmp|\$RUNNER_TEMP|\$\{RUNNER_TEMP\}|\$\{\{\s*runner\.temp\s*\}\}|%TEMP%|\$env:TEMP|\$TMPDIR|\.npm-tmp)/i;

/** What a command does to the package cache that the job restored, if anything. */
function cacheDefeat(command: string): { ecosystem: Ecosystem; what: string } | undefined {
  const words = toolWords(command);
  const [tool, sub, third] = words;
  if (tool === "npm" && sub === "cache" && third === "clean") return { ecosystem: "npm", what: "`npm cache clean` empties" };
  if (tool === "yarn" && sub === "cache" && third === "clean") return { ecosystem: "yarn", what: "`yarn cache clean` empties" };
  if (tool === "pnpm" && sub === "store" && third === "prune") return { ecosystem: "pnpm", what: "`pnpm store prune` shrinks" };
  if (tool === "npm" && (sub === "ci" || sub === "install" || sub === "i")) {
    for (let i = 2; i < words.length; i++) {
      const word = words[i] ?? "";
      const value = word.startsWith("--cache=") ? word.slice("--cache=".length) : word === "--cache" ? words[i + 1] : undefined;
      if (value !== undefined && TEMP_CACHE.test(value)) return { ecosystem: "npm", what: `\`npm ${sub} --cache ${value}\` bypasses` };
    }
  }
  const pip = tool === "pip" || tool === "pip3" || (tool === "uv" && sub === "pip");
  const pipArgs = tool === "uv" ? words.slice(2) : words.slice(1);
  if (pip && pipArgs[0] === "install" && pipArgs.includes("--no-cache-dir")) {
    return { ecosystem: "pip", what: "`pip install --no-cache-dir` bypasses" };
  }
  if ((tool === "pip" || tool === "pip3") && sub === "cache" && (third === "purge" || third === "remove")) {
    return { ecosystem: "pip", what: `\`pip cache ${third}\` empties` };
  }
  return undefined;
}

function setupCache(steps: StepModel[], action: string, values: RegExp): boolean {
  return steps.some((step) => {
    if (!usesAction(step, action)) return false;
    const cache = step.with.get("cache");
    return cache !== undefined && (cache.kind !== "literal" || values.test(String(cache.value)));
  });
}

function restoresCache(steps: StepModel[], ecosystem: Ecosystem): boolean {
  if (ecosystem === "pip") return setupCache(steps, "actions/setup-python", /pip/i) || cacheCovers(steps, /pip/i, /pip/i);
  return setupCache(steps, "actions/setup-node", new RegExp(ecosystem, "i")) || cacheCovers(steps, new RegExp(ecosystem === "pnpm" ? "pnpm" : ecosystem === "yarn" ? "yarn" : "\\.npm|npm", "i"), new RegExp(ecosystem, "i"));
}

export default defineRule({
  meta: {
    id: "testing/cache-disabled-install",
    ruleset: "testing",
    description: "Jobs that restore a package-manager cache should not clear or bypass that cache in their run steps.",
    rationale:
      "Restoring a dependency cache costs a download and a save on every run; clearing it, pointing installs at an empty temporary cache or passing `--no-cache-dir` throws that work away and makes every install download from the registry again.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/setup-node#caching-global-packages-data",
      "https://github.com/actions/setup-python#caching-packages-dependencies",
      "https://docs.npmjs.com/cli/commands/npm-cache",
    ],
    impact: "low",
    example: {
      bad: "- uses: actions/setup-node@v4\n  with:\n    cache: npm\n- run: npm cache clean --force && npm ci",
      good: "- uses: actions/setup-node@v4\n  with:\n    cache: npm\n- run: npm ci",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const commands = jobCommands(project, workflow, job);
        if (commands.length === 0) continue;
        const all = project.expandedSteps(job);
        for (const entry of commands) {
          const defeat = cacheDefeat(entry.command);
          if (!defeat || !restoresCache(all, defeat.ecosystem)) continue;
          report({
            path: workflow.path,
            line: entry.direct ? entry.line : stepLine(entry.owner),
            key: `${entry.step.key}:${defeat.ecosystem}:${entry.command}`,
            message: `${defeat.what} the ${defeat.ecosystem} cache that job \`${job.id}\` restores, so the restore is wasted and dependencies download again.`,
            suggestion: "Drop the cache-clearing command or flag and let the install use the restored cache.",
          });
        }
      }
    }
  },
});
