import { parse } from "yaml";
import { hasTrigger, type WorkflowModel } from "../../parsers/workflow.js";
import type { NixFlake } from "../../project.js";
import type { SourceFile } from "../../types.js";
import { commandsOf, defineRule } from "../helpers.js";
import { SAMPLE_DIR, flakePath, lockOf, str } from "./flake.js";

interface TrackedLock {
  path: string;
  dir: string;
  inputs: number;
  oldest?: { name: string; date: string };
}

const DEPENDABOT = /^\.github\/dependabot\.ya?ml$/;
const RENOVATE_CONFIG = /^(?:\.github\/|\.gitlab\/)?(?:renovate\.json5?|\.renovaterc(?:\.json5?)?)$/;

/** Renovate's built-in preset namespaces (https://docs.renovatebot.com/presets-default/); anything else is a shared preset this rule cannot read. */
const BUILT_IN_PRESETS = new Set([
  "",
  "abandonments",
  "config",
  "customManagers",
  "default",
  "docker",
  "global",
  "group",
  "helpers",
  "mergeConfidence",
  "monorepo",
  "npm",
  "packages",
  "preview",
  "regexManagers",
  "replacements",
  "schedule",
  "security",
  "workarounds",
]);

/** Triggers that run a workflow without a code change, so it can land lock updates on its own. */
const AUTOMATED_TRIGGERS = ["schedule", "workflow_dispatch", "repository_dispatch", "workflow_call"];

export default defineRule({
  meta: {
    id: "nix/no-lock-update-automation",
    ruleset: "nix",
    description: "A committed flake.lock has no Dependabot, Renovate or scheduled workflow keeping it up to date.",
    rationale:
      "Committed locks require deliberate maintenance. Repository-visible Dependabot, Renovate or update workflows can make that maintenance reviewable, but external services and manual targeted updates may already provide it. A commit timestamp is not a vulnerability assessment or proof of neglect. Even a small update can change a large build closure; automation does not guarantee smaller cache misses. Review and test update pull requests before merging.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#package-ecosystem-",
      "https://docs.renovatebot.com/modules/manager/nix/",
      "https://github.com/DeterminateSystems/update-flake-lock",
    ],
    impact: "medium",
    example: {
      bad: "# flake.lock committed; .github/dependabot.yml only covers github-actions\nversion: 2\nupdates:\n  - package-ecosystem: \"github-actions\"\n    directory: \"/\"\n    schedule:\n      interval: \"weekly\"",
      good: "version: 2\nupdates:\n  - package-ecosystem: \"github-actions\"\n    directory: \"/\"\n    schedule:\n      interval: \"weekly\"\n  - package-ecosystem: \"nix\"\n    directory: \"/\"\n    schedule:\n      interval: \"weekly\"",
    },
  },
  check({ project, report }) {
    const locks = trackedLocks(project.nix.flakes);
    if (locks.length === 0) return;
    const files = [...project.files.values()];
    if (workflowAutomation(project.workflows) || renovateEnabled(files)) return;

    const dependabot = files.find((file) => DEPENDABOT.test(file.path));
    const coverage = dependabot ? dependabotNixCoverage(dependabot.content) : { entries: false, patterns: [] };
    if (coverage === "unknown") return;
    const uncovered = locks.filter((lock) => !coverage.patterns.some((pattern) => pattern.test(lock.dir)));
    const first = uncovered[0];
    if (!first) return;

    const gaps: string[] = [];
    if (!dependabot) gaps.push("no `.github/dependabot.yml`");
    else if (!coverage.entries) gaps.push(`\`${dependabot.path}\` has no \`package-ecosystem: "nix"\` entry`);
    else gaps.push(`the \`nix\` entries in \`${dependabot.path}\` do not list ${uncovered.length === 1 ? "its directory" : "their directories"}`);
    const renovate = files.find((file) => RENOVATE_CONFIG.test(file.path));
    gaps.push(renovate ? `\`${renovate.path}\` does not enable Renovate's \`nix\` manager (it is off by default)` : "no Renovate `nix` manager");
    const manual = manualUpdateWorkflow(project.workflows);
    gaps.push(
      manual
        ? `\`${manual}\` runs \`nix flake update\` but has no \`schedule:\`/dispatch trigger, so it never runs on its own`
        : "no scheduled `nix flake update`/`DeterminateSystems/update-flake-lock` workflow",
    );

    const subject =
      uncovered.length === 1
        ? `\`${first.path}\` pins ${first.inputs} ${first.inputs === 1 ? "input" : "inputs"}${first.oldest ? ` (oldest pinned commit: \`${first.oldest.name}\` from ${first.oldest.date})` : ""}`
        : `${uncovered.length} lock files (${uncovered.map((lock) => `\`${lock.path}\``).join(", ")})`;
    const dirs = uncovered.map((lock) => `/${lock.dir}`);
    const location = dirs.length === 1 ? `    directory: "${dirs[0]}"` : `    directories:\n${dirs.map((dir) => `      - "${dir}"`).join("\n")}`;
    const entry = `  - package-ecosystem: "nix"\n${location}\n    schedule:\n      interval: "weekly"`;
    const snippet = dependabot && /^updates\s*:/m.test(dependabot.content) ? entry : `version: 2\nupdates:\n${entry}`;

    report({
      path: first.path,
      line: 1,
      key: "no-lock-update-automation",
      message: `${subject}, with no recognized repository-local update automation: ${gaps.join("; ")}. External services or manual updates may already cover this; confirm the maintenance policy before adding another updater.`,
      suggestion: `${dependabot ? `Add this entry under \`updates:\` in \`${dependabot.path}\`` : "Create `.github/dependabot.yml`"} so Dependabot opens pull requests that bump the flake inputs:\n\n${snippet}\n\nAlternatives: enable Renovate's beta manager with \`"nix": { "enabled": true }\` (plus \`"lockFileMaintenance": { "enabled": true }\` for whole-lock refreshes), or add a weekly \`schedule:\` workflow that runs \`DeterminateSystems/update-flake-lock\` after installing Nix.`,
      ...(uncovered.length > 1 ? { related: uncovered.slice(1).map((lock) => ({ path: lock.path, line: 1 })) } : {}),
    });
  },
});

function trackedLocks(flakes: NixFlake[]): TrackedLock[] {
  const result: TrackedLock[] = [];
  for (const flake of flakes) {
    const lock = lockOf(flake);
    if (!lock || !flake.nix || SAMPLE_DIR.test(flake.dir)) continue;
    let inputs = 0;
    let oldest: { name: string; modified: number } | undefined;
    for (const [name, reference] of Object.entries(lock.rootInputs)) {
      if (typeof reference !== "string") continue;
      const node = lock.nodes.get(reference);
      const type = str(node?.locked?.type) ?? str(node?.original?.type);
      // Path inputs point into the repository itself; there is nothing upstream to update.
      if (!node || type === "path") continue;
      inputs += 1;
      const modified = node.locked?.lastModified;
      if (typeof modified === "number" && Number.isFinite(modified) && modified > 0 && modified <= 8_640_000_000_000 && (!oldest || modified < oldest.modified)) oldest = { name, modified };
    }
    if (inputs === 0) continue;
    result.push({
      path: lock.path || flakePath(flake.dir, "flake.lock"),
      dir: flake.dir,
      inputs,
      ...(oldest ? { oldest: { name: oldest.name, date: new Date(oldest.modified * 1000).toISOString().slice(0, 10) } } : {}),
    });
  }
  return result;
}

/** A workflow that updates locks on its own: an update action, self-hosted Renovate, or `nix flake update` on a schedule/dispatch. */
function workflowAutomation(workflows: WorkflowModel[]): boolean {
  return workflows.some((workflow) => {
    const steps = workflow.jobs.flatMap((job) => job.steps);
    if (steps.some((step) => updateAction(step.uses?.action?.name))) return true;
    return hasTrigger(workflow, ...AUTOMATED_TRIGGERS) && steps.some((step) => updatesLock(step.run?.value ?? ""));
  });
}

function updateAction(name: string | undefined): boolean {
  if (!name) return false;
  const [owner = "", repo = ""] = name.split("/");
  if (owner === "renovatebot" && repo === "github-action") return true;
  return /flake/.test(repo) && /update|lock|bump/.test(repo);
}

function updatesLock(script: string): boolean {
  return (
    /\bnix\b[^\n;|&]*\bflake\s+update\b/.test(script) ||
    /\bnix\b[^\n;|&]*\bflake\s+lock\b[^\n;|&]*--(?:update-input|recreate-lock-file)\b/.test(script) ||
    /\b(?:update[-_]flake|flake[-_]update)/i.test(script)
  );
}

/** A push/PR-only workflow that runs `nix flake update` (typically a dry check), named in the message. */
function manualUpdateWorkflow(workflows: WorkflowModel[]): string | undefined {
  return workflows.find((workflow) =>
    workflow.jobs.some((job) => job.steps.some((step) => commandsOf(step).some(({ command }) => /\bnix\b.*\bflake\s+update\b/.test(command)))),
  )?.path;
}

/**
 * Directory patterns of `package-ecosystem: nix` entries; `"unknown"` when the file cannot be read
 * or uses patterns this rule does not evaluate (the rule then stays silent).
 */
function dependabotNixCoverage(content: string): { entries: boolean; patterns: RegExp[] } | "unknown" {
  let config: unknown;
  try {
    config = parse(content);
  } catch {
    return "unknown";
  }
  if (config === null || config === undefined) return { entries: false, patterns: [] };
  if (typeof config !== "object") return "unknown";
  const updates = (config as { updates?: unknown }).updates;
  if (updates === undefined) return { entries: false, patterns: [] };
  if (!Array.isArray(updates)) return "unknown";
  const patterns: RegExp[] = [];
  let entries = false;
  for (const update of updates as unknown[]) {
    if (typeof update !== "object" || update === null) continue;
    const fields = update as Record<string, unknown>;
    const ecosystem = fields["package-ecosystem"];
    if (typeof ecosystem !== "string") return "unknown";
    if (ecosystem !== "nix") continue;
    entries = true;
    const dirs = [fields.directory, ...(Array.isArray(fields.directories) ? fields.directories : [fields.directories])].filter(
      (dir) => dir !== undefined,
    );
    if (dirs.length === 0) return "unknown";
    for (const dir of dirs) {
      const pattern = typeof dir === "string" ? directoryPattern(dir) : undefined;
      if (!pattern) return "unknown";
      patterns.push(pattern);
    }
  }
  return { entries, patterns };
}

/** Dependabot directory (`/`, `/nix`, `/apps/*`, `/**`) as a matcher over repository-relative directories (`""` is the root). */
function directoryPattern(dir: string): RegExp | undefined {
  const trimmed = dir.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (/[?[\]{}!$]/.test(trimmed)) return undefined;
  if (trimmed === "") return /^$/;
  const ANY = "\u0000";
  let source = trimmed
    .split("/")
    .map((segment) => (segment === "**" ? ANY : segment.replace(/[.+^()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/");
  if (source === ANY) return /^/;
  source = source
    .replace(new RegExp(`^${ANY}/`), "(?:.*/)?")
    .replace(new RegExp(`/${ANY}$`), "(?:/.*)?")
    .replaceAll(`/${ANY}/`, "(?:/.*)?/");
  return source.includes(ANY) ? undefined : new RegExp(`^${source}$`);
}

/** Renovate configured with the `nix` manager on, or extending a shared preset that might enable it. */
function renovateEnabled(files: SourceFile[]): boolean {
  const configs: string[] = [];
  for (const file of files) {
    if (RENOVATE_CONFIG.test(file.path)) configs.push(file.content);
    else if (file.path === "package.json") {
      try {
        const manifest = JSON.parse(file.content) as { renovate?: unknown };
        if (manifest.renovate !== undefined) configs.push(JSON.stringify(manifest.renovate));
      } catch {
        // Unparsable manifests carry no Renovate config this rule can read.
      }
    }
  }
  return configs.some(
    (text) =>
      /["']?\bnix["']?\s*:\s*\{[^{}]*?["']?enabled["']?\s*:\s*true\b/.test(text) ||
      /["']?enabledManagers["']?\s*:\s*\[[^\]]*["']nix["']/.test(text) ||
      sharedPresets(text),
  );
}

function sharedPresets(text: string): boolean {
  const list = /["']?extends["']?\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  if (!list) return false;
  return [...list.matchAll(/["']([^"']+)["']/g)].some(([, preset = ""]) => {
    if (preset.includes(">") || preset.startsWith("@") || !preset.includes(":")) return true;
    return !BUILT_IN_PRESETS.has(preset.slice(0, preset.indexOf(":")));
  });
}
