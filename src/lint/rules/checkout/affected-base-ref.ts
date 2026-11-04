import type { StepModel } from "../../parsers/workflow.js";
import { affectedTooling, commandsOf, defineRule, expandedJobSteps, type ExpandedStep } from "../helpers.js";

const GIT_FETCH = /\bgit\s+(?:fetch|pull)\b/;

function isSelfCheckout(step: StepModel): boolean {
  if (step.uses?.action.name !== "actions/checkout") return false;
  const repository = step.with.get("repository");
  return !repository || (repository.kind !== "literal" && /github\.repository\b/.test(String(repository.value)));
}

function isShallow(step: StepModel): boolean {
  const depth = step.with.get("fetch-depth");
  return !depth || (depth.kind === "literal" && (depth.value === 1 || depth.value === "1"));
}

/** Changed-only modes with no explicit base compare against uncommitted changes, which a CI checkout never has. */
function hasNoBase(command: string, tool: string): boolean {
  const text = command.replace(/["']/g, "");
  if (tool === "jest --onlyChanged") return true;
  if (tool === "vitest --changed") return !/\s--changed(?:=\S+|\s+(?!-)\S+)/.test(text);
  return false;
}

export default defineRule({
  meta: {
    id: "checkout/affected-base-ref",
    ruleset: "checkout",
    description: "Affected/changed-only commands need the base commit, which a default shallow checkout does not fetch.",
    rationale:
      "`actions/checkout` fetches a single commit by default. Affected-only tooling (nx affected, turbo --affected, pnpm/turbo `[ref]` filters, jest --changedSince, git diff against the base) then either fails with an unknown revision or silently falls back to running everything, which defeats the selection that makes agent-scale CI affordable.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/checkout#fetch-all-history-for-all-tags-and-branches",
      "https://nx.dev/docs/features/ci-features/affected",
      "https://github.com/nrwl/nx-set-shas",
      "https://turborepo.com/docs/reference/run#--affected",
    ],
    impact: "high",
    example: {
      bad: "- uses: actions/checkout@v7\n- run: npx nx affected -t test",
      good: "- uses: actions/checkout@v7\n  with:\n    fetch-depth: 0\n    filter: blob:none\n- uses: nrwl/nx-set-shas@v5\n- run: npx nx affected -t test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const expanded = expandedJobSteps(project, workflow, job);
        if (expanded.some(({ step }) => step.uses?.action.name === "nrwl/nx-set-shas")) continue;
        let checkout: ExpandedStep | undefined;
        let fetched = false;
        for (const entry of expanded) {
          if (isSelfCheckout(entry.step)) {
            checkout = entry;
            fetched = false;
          }
          for (const { command, line } of commandsOf(entry.step)) {
            if (GIT_FETCH.test(command)) fetched = true;
            const tool = affectedTooling(command);
            if (!tool || !checkout || fetched || !isShallow(checkout.step)) continue;
            const noBase = hasNoBase(command, tool);
            const nxHint = tool === "nx affected" ? " For Nx, also add `nrwl/nx-set-shas@v5` after checkout so NX_BASE is the last successful default-branch commit." : "";
            report({
              path: entry.path,
              line,
              key: `${entry.owner.key}:${tool}`,
              message: noBase
                ? `\`${tool}\` without a base ref compares against uncommitted changes, so in a shallow CI checkout it selects nothing.`
                : `\`${tool}\` needs the base commit, but actions/checkout only fetched one commit (default fetch-depth: 1), so it fails or treats everything as changed.`,
              suggestion: noBase
                ? "Pass an explicit base (for example `--changedSince=origin/${{ github.base_ref }}` or `--changed origin/${{ github.base_ref }}`) and fetch it first with `git fetch --no-tags --depth=<n> origin ${{ github.base_ref }}`, or set `fetch-depth: 0` with `filter: blob:none` on checkout."
                : `Fetch the base before this command: set \`fetch-depth: 0\` and \`filter: blob:none\` on actions/checkout (full history, file contents on demand), or run \`git fetch --no-tags --depth=<n> origin \${{ github.base_ref }}\` first.${nxHint}`,
              related: [{ path: checkout.path, line: checkout.step.uses?.line ?? checkout.step.line }],
              ...(noBase ? { confidence: "medium" as const } : {}),
            });
          }
        }
      }
    }
  },
});
