import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseRepo } from "../github/rest.js";
import type { GitHubClient } from "../github/client.js";
import { HILL_CLIMB_CONFIG_PATH, parseHillClimbConfig, type HillClimbConfig } from "../experiments/config.js";
import { parseManifest } from "../experiments/manifest.js";
import { applyRecipe, publishRecipe, recipeStatus, type RecipeApplyResult } from "../recipes/github.js";
import { parseRecipe, recipePath, RECIPES_DIR, serializeRecipe, type Recipe } from "../recipes/recipe.js";
import { DEFAULT_ROLLOUT, parseRolloutTargets, planRollout, type RolloutConfig, type RolloutPlan, type TargetStatus } from "../recipes/rollout.js";
import { copilotClient, githubClient, repoFrom, resolvePath, UsageError, writeText, type CliIO } from "./io.js";
import { usingKnowledgeStore } from "./knowledge-store.js";

export const RECIPES_HELP = `Usage: ci-cd-optimizer recipes <command> [options]

Reusable fixes built from promoted pipeline experiments, rolled out to other repositories
Dependabot-style with a CI-based compatibility score (see docs/recipes.md).

Commands:
  publish     Build recipes/<id>.yml from a promoted experiment and its merged winning arm
  apply       Open (or sync) the recipe's pull request / adaptation issue in one repository
  status      Show the recipe's state in each target and the rollout decision
  rollout     Apply the recipe to the next wave of targets when the previous wave proved compatible

Options:
      --repo <owner/name>     Source repository for publish (default: $GITHUB_REPOSITORY)
      --recipe <file>         Recipe file (apply, status, rollout)
      --targets <file>        Targets file: repositories, canaries, rollout waves (status, rollout)
      --repos <a,b>           Comma-separated targets instead of --targets
      --canary <a,b>          Repositories to roll out to first
      --format text|json      Output format (default: text)
      --dry-run               Plan without opening or updating pull requests and issues
      --record-knowledge      apply/rollout: record authenticated published-recipe proposals in DATABASE_URL

publish:  --experiment <name> [--manifest <file>] [--ref <branch>] [--output-dir ${RECIPES_DIR}] [--config <file>]
apply:    --recipe <file> --target <owner/name> [--dry-run]
status:   --recipe <file> (--targets <file> | --repos <a,b>) [--write]
rollout:  --recipe <file> (--targets <file> | --repos <a,b>) [--canary <a,b>] [--max-scan <n>] [--write] [--summary <file>] [--dry-run]

--write stores the current compatibility counts in the recipe file (commit it to publish the score).
Cross-repository writes need a token that can open pull requests in the targets, such as a GitHub App
installation token. Set COPILOT_ASSIGN_TOKEN to assign adaptation issues to the Copilot coding agent.
`;

const COMMON = {
  format: { type: "string", short: "f", default: "text" },
  "dry-run": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

async function readText(io: CliIO, path: string): Promise<string> {
  try {
    return await readFile(resolvePath(io, path), "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

async function loadRecipe(io: CliIO, path: string | undefined): Promise<Recipe> {
  if (!path) throw new UsageError("--recipe <file> is required.");
  const parsed = parseRecipe(await readText(io, path));
  if (!parsed.recipe) throw new UsageError(`Invalid recipe ${path}:\n${parsed.problems.map((problem) => `  ${problem}`).join("\n")}`);
  return parsed.recipe;
}

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

function checkRepos(names: readonly string[], flag: string): string[] {
  for (const name of names) {
    try {
      parseRepo(name);
    } catch {
      throw new UsageError(`${flag}: "${name}" is not an owner/name repository.`);
    }
  }
  return [...new Set(names)];
}

interface Targets {
  repositories: string[];
  canaries: string[];
  config: RolloutConfig;
}

async function loadTargets(io: CliIO, values: { targets?: string | undefined; repos?: string | undefined; canary?: string | undefined }): Promise<Targets> {
  if (values.targets && values.repos) throw new UsageError("Use either --targets or --repos, not both.");
  let targets: Targets;
  if (values.targets) {
    const parsed = parseRolloutTargets(await readText(io, values.targets));
    if (parsed.problems.length > 0) throw new UsageError(`Invalid ${values.targets}:\n${parsed.problems.map((problem) => `  ${problem}`).join("\n")}`);
    targets = parsed;
  } else if (values.repos) {
    targets = { repositories: checkRepos(list(values.repos), "--repos"), canaries: [], config: DEFAULT_ROLLOUT };
  } else {
    throw new UsageError("--targets <file> or --repos <a,b> is required.");
  }
  if (values.canary) {
    const canaries = checkRepos(list(values.canary), "--canary");
    const unknown = canaries.filter((canary) => !targets.repositories.includes(canary));
    if (unknown.length > 0) throw new UsageError(`--canary: ${unknown.join(", ")} not in the targets.`);
    targets = { ...targets, canaries };
  }
  return targets;
}


function format(value: string | undefined): "text" | "json" {
  if (value === "text" || value === "json") return value;
  throw new UsageError(`Unknown format "${value}". Use text or json.`);
}

async function loadHillClimbConfig(io: CliIO, explicit: string | undefined): Promise<HillClimbConfig> {
  const path = resolvePath(io, explicit ?? HILL_CLIMB_CONFIG_PATH);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !explicit) return undefined;
    throw new UsageError(`Cannot read ${path}: ${error.message}`);
  });
  const parsed = parseHillClimbConfig(text);
  if (parsed.problems.length > 0) throw new UsageError(`Invalid ${path}:\n${parsed.problems.map((p) => `  ${p.path || "(root)"}: ${p.message}`).join("\n")}`);
  return parsed.config;
}

async function publishCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { ...COMMON, repo: { type: "string" }, config: { type: "string" }, experiment: { type: "string" }, manifest: { type: "string" }, ref: { type: "string" }, "output-dir": { type: "string", default: RECIPES_DIR } },
  });
  const outputFormat = format(values.format);
  const config = await loadHillClimbConfig(io, values.config);
  let manifest;
  if (values.manifest) {
    const parsed = parseManifest(await readText(io, values.manifest), { config });
    if (!parsed.manifest) throw new UsageError(`Invalid ${values.manifest}:\n${parsed.problems.map((p) => `  ${p.path}: ${p.message}`).join("\n")}`);
    manifest = parsed.manifest;
  }
  const experiment = values.experiment ?? manifest?.name;
  if (!experiment) throw new UsageError("--experiment <name> or --manifest <file> is required.");
  if (manifest && manifest.name !== experiment) throw new UsageError(`--manifest is for "${manifest.name}", not "${experiment}".`);
  const repo = repoFrom(values.repo, io);
  const outputDir = values["output-dir"] ?? RECIPES_DIR;
  const target = resolvePath(io, recipePath(experiment, outputDir));
  const existing = await readFile(target, "utf8").catch(() => undefined);
  const previous = existing === undefined ? undefined : parseRecipe(existing).recipe;
  const built = await publishRecipe(githubClient(io), repo, {
    experiment,
    config,
    ...(manifest ? { manifest } : {}),
    ...(values.ref ? { ref: values.ref } : {}),
    ...(previous ? { previous } : {}),
  });
  if ("error" in built) {
    if (built.skipped) {
      io.stderr(`Skipped: ${built.error}`);
      if (outputFormat === "json") io.stdout(JSON.stringify({ experiment, skipped: true, reason: built.error }, null, 2));
      return 0;
    }
    throw new Error(built.error);
  }
  const path = recipePath(built.recipe.id, outputDir);
  if (built.changed && !values["dry-run"]) await writeText(io, path, serializeRecipe(built.recipe));
  if (outputFormat === "json") {
    io.stdout(JSON.stringify({ id: built.recipe.id, revision: built.recipe.revision, risk: built.recipe.risk, changed: built.changed, path, written: built.changed && !values["dry-run"] }, null, 2));
  } else {
    const verb = !built.changed ? "unchanged" : values["dry-run"] ? "would write" : "wrote";
    io.stdout(`${path}: ${verb} (revision ${built.recipe.revision}, risk ${built.recipe.risk}, ${built.recipe.rules.length} rule(s), ${built.recipe.patchFiles.length} file(s))`);
    if (values["dry-run"] && built.changed) io.stdout(serializeRecipe(built.recipe));
  }
  return 0;
}

function describeApply(result: RecipeApplyResult): string {
  if (result.error) return `${result.repo}: failed - ${result.error}`;
  const links = [
    result.pullRequest !== undefined ? `PR #${result.pullRequest}` : "",
    result.issue !== undefined ? `issue #${result.issue}${result.copilot ? ` (assigned to ${result.copilot})` : ""}` : "",
  ].filter(Boolean);
  const problems = result.configProblems?.length ? `\n  ${result.configProblems.join("\n  ")}` : "";
  return `${result.repo}: ${result.plan.status}${links.length ? ` → ${links.join(", ")}` : ""} - ${result.plan.reason}${problems}`;
}

function applySummary(result: RecipeApplyResult) {
  return {
    repo: result.repo,
    status: result.error ? "failed" : result.plan.status,
    reason: result.plan.reason,
    attempted: result.attempted,
    rules: result.plan.rules,
    remaining: result.plan.remaining.map((diagnostic) => ({ ruleId: diagnostic.ruleId, path: diagnostic.path, line: diagnostic.line })),
    ...(result.pullRequest !== undefined ? { pullRequest: result.pullRequest } : {}),
    ...(result.issue !== undefined ? { issue: result.issue } : {}),
    ...(result.copilot ? { copilot: result.copilot } : {}),
    ...(result.configProblems ? { configProblems: result.configProblems } : {}),
    ...(result.knowledge ? { knowledge: result.knowledge } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function applyCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: {
    ...COMMON, recipe: { type: "string" }, target: { type: "string" }, "record-knowledge": { type: "boolean", default: false },
  } });
  const outputFormat = format(values.format);
  const recipe = await loadRecipe(io, values.recipe);
  if (!values.target) throw new UsageError("--target <owner/name> is required.");
  const target = repoFrom(values.target, io);
  const copilot = copilotClient(io);
  const result = await usingKnowledgeStore(io, values["record-knowledge"] && !values["dry-run"], (knowledgeStore) => applyRecipe(githubClient(io), target, recipe, {
    dryRun: values["dry-run"],
    ...(copilot ? { copilotClient: copilot } : {}),
    ...(io.env.GITHUB_SERVER_URL ? { server: io.env.GITHUB_SERVER_URL } : {}),
    ...(knowledgeStore ? { knowledgeStore } : {}),
  }));
  io.stdout(outputFormat === "json" ? JSON.stringify(applySummary(result), null, 2) : describeApply(result));
  return result.configProblems ? 1 : 0;
}

async function collectStatuses(client: GitHubClient, recipe: Recipe, repositories: readonly string[], server: string): Promise<TargetStatus[]> {
  const statuses: TargetStatus[] = [];
  for (const name of repositories) statuses.push(await recipeStatus(client, parseRepo(name), recipe, server));
  return statuses;
}

/** Writes the observed compatibility into the recipe file when it changed (returns whether it did). */
async function storeCompatibility(io: CliIO, path: string, recipe: Recipe, plan: RolloutPlan): Promise<boolean> {
  const next = { passed: plan.counts.passed, failed: plan.counts.failed };
  if (next.passed === recipe.compatibility.passed && next.failed === recipe.compatibility.failed) return false;
  await writeText(io, path, serializeRecipe({ ...recipe, compatibility: next }));
  return true;
}

function renderStatus(recipe: Recipe, statuses: readonly TargetStatus[], plan: RolloutPlan, applied: readonly RecipeApplyResult[] = []): string {
  const lines = [
    `## ♻️ Recipe rollout: ${recipe.title} (\`${recipe.id}\` r${recipe.revision})`,
    "",
    `**Decision:** ${plan.action} - ${plan.reason}`,
    "",
    `**Compatibility:** ${plan.compatibility.display}`,
    "",
    "| Repository | State | Change |",
    "| --- | --- | --- |",
  ];
  for (const status of statuses) {
    const change = status.number !== undefined ? (status.url ? `[#${status.number}](${status.url})` : `#${status.number}`) : "";
    lines.push(`| ${status.repo} | ${status.state} | ${change} |`);
  }
  if (applied.length > 0) {
    lines.push("", "### This run", "");
    for (const result of applied) lines.push(`- ${describeApply(result)}`);
  }
  return lines.join("\n");
}

async function statusCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { ...COMMON, recipe: { type: "string" }, targets: { type: "string" }, repos: { type: "string" }, canary: { type: "string" }, write: { type: "boolean", default: false } } });
  const outputFormat = format(values.format);
  const recipe = await loadRecipe(io, values.recipe);
  const targets = await loadTargets(io, values);
  const server = io.env.GITHUB_SERVER_URL ?? "https://github.com";
  const statuses = await collectStatuses(githubClient(io), recipe, targets.repositories, server);
  const plan = planRollout({ id: recipe.id, targets: statuses, config: targets.config, canaries: targets.canaries });
  if (values.write) await storeCompatibility(io, values.recipe as string, recipe, plan);
  io.stdout(outputFormat === "json" ? JSON.stringify({ recipe: recipe.id, revision: recipe.revision, statuses, plan }, null, 2) : renderStatus(recipe, statuses, plan));
  return 0;
}

async function rolloutCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...COMMON,
      recipe: { type: "string" },
      targets: { type: "string" },
      repos: { type: "string" },
      canary: { type: "string" },
      write: { type: "boolean", default: false },
      summary: { type: "string" },
      "max-scan": { type: "string", default: "50" },
      "record-knowledge": { type: "boolean", default: false },
    },
  });
  const outputFormat = format(values.format);
  const maxScan = Number(values["max-scan"]);
  if (!Number.isInteger(maxScan) || maxScan < 1) throw new UsageError("--max-scan must be a positive integer.");
  const recipe = await loadRecipe(io, values.recipe);
  const targets = await loadTargets(io, values);
  const client = githubClient(io);
  const server = io.env.GITHUB_SERVER_URL ?? "https://github.com";
  const statuses = await collectStatuses(client, recipe, targets.repositories, server);
  const plan = planRollout({ id: recipe.id, targets: statuses, config: targets.config, canaries: targets.canaries });

  const applied: RecipeApplyResult[] = [];
  await usingKnowledgeStore(io, values["record-knowledge"] && !values["dry-run"], async (knowledgeStore) => {
    if (plan.action !== "advance") return;
    const copilot = copilotClient(io);
    let opened = 0;
    let scanned = 0;
    // Candidates that turn out not to apply (no matching findings, opted out, too risky) do not use a slot.
    for (const name of plan.candidates) {
      if (opened >= plan.slots || scanned >= maxScan) break;
      scanned += 1;
      try {
        const result = await applyRecipe(client, parseRepo(name), recipe, {
          dryRun: values["dry-run"],
          compatibility: { passed: plan.counts.passed, failed: plan.counts.failed },
          ...(copilot ? { copilotClient: copilot } : {}),
          server,
          ...(knowledgeStore ? { knowledgeStore } : {}),
        });
        applied.push(result);
        const opens = values["dry-run"] ? ["autofix", "partial", "adapt"].includes(result.plan.status) : result.attempted;
        if (opens) opened += 1;
      } catch (error) {
        applied.push({
          repo: name,
          attempted: false,
          error: (error as Error).message,
          plan: { status: "ignored", reason: `Failed: ${(error as Error).message}`, rules: [], remaining: [], matchedFiles: [] },
        });
      }
    }
  });
  if (values.write && !values["dry-run"]) await storeCompatibility(io, values.recipe as string, recipe, plan);
  const markdown = renderStatus(recipe, statuses, plan, applied);
  if (values.summary) await writeText(io, values.summary, markdown);
  io.stdout(
    outputFormat === "json"
      ? JSON.stringify({ recipe: recipe.id, revision: recipe.revision, plan, statuses, applied: applied.map(applySummary) }, null, 2)
      : markdown,
  );
  return applied.some((result) => result.error) ? 1 : 0;
}

const COMMANDS: Record<string, (args: string[], io: CliIO) => Promise<number>> = {
  publish: publishCommand,
  apply: applyCommand,
  status: statusCommand,
  rollout: rolloutCommand,
};

export async function recipesCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.stdout(RECIPES_HELP);
    return command && !COMMANDS[command] && command !== "--help" && command !== "-h" ? 2 : 0;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`Unknown recipes command "${command}". Commands: ${Object.keys(COMMANDS).join(", ")}.`);
  return handler(rest, io);
}
