import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { matrixCombinations, matrixText } from "../../parsers/matrix.js";
import { defineRule } from "../helpers.js";
import {
  isBuildPush,
  isDynamic,
  jobBuilds,
  siteCacheEntries,
  siteCacheLine,
  siteDockerfile,
  type BuildSite,
  type CacheEntry,
} from "./buildx.js";

const MATRIX_REFERENCE = /\bmatrix\.([A-Za-z_][\w-]*)/g;
const OVERWRITE =
  "every writer uses the default scope `buildkit`, and Docker's gha cache documentation warns that \"each build will overwrite the cache of the previous, leaving only the final cache\"";

/** Matrix dimensions that differ between legs; `undefined` means the matrix is computed and any dimension may vary. */
function varyingDimensions(job: JobModel): Set<string> | undefined {
  const matrix = job.matrix;
  if (!matrix) return new Set();
  if ("__expression" in matrix) return undefined;
  const varying = new Set<string>();
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "exclude") continue;
    if (key === "include") {
      if (!Array.isArray(value)) return undefined;
      const seen = new Map<string, Set<string>>();
      for (const leg of value) {
        if (typeof leg !== "object" || leg === null) continue;
        for (const [dimension, dimensionValue] of Object.entries(leg as Record<string, unknown>)) {
          const values = seen.get(dimension) ?? new Set<string>();
          values.add(JSON.stringify(dimensionValue));
          seen.set(dimension, values);
        }
      }
      for (const [dimension, values] of seen) if (values.size >= 2) varying.add(dimension);
      continue;
    }
    if ((Array.isArray(value) && value.length >= 2) || (typeof value === "string" && value.includes("${{"))) varying.add(key);
  }
  return varying;
}

/**
 * Matrix dimensions that shape what this build produces: referenced by build inputs, by the command itself, by step
 * environment variables the command expands, or by `runs-on` (a different runner architecture builds a different image).
 */
function referencedDimensions(job: JobModel, step: StepModel, command: string | undefined): string[] {
  const texts = [JSON.stringify(job.runsOn?.value ?? "")];
  if (command === undefined) texts.push(JSON.stringify([...step.with.values()].map((entry) => entry.value)));
  else {
    texts.push(command);
    for (const [name, value] of Object.entries(step.env)) {
      if (/^\w+$/.test(name) && new RegExp(`\\$\\{?${name}\\b`).test(command)) texts.push(JSON.stringify(value));
    }
  }
  const names = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(MATRIX_REFERENCE)) if (match[1]) names.add(match[1]);
  return [...names];
}

function cacheTo(site: BuildSite): CacheEntry[] {
  return siteCacheEntries(site, "cache-to");
}

function entryLine(project: ProjectModel, site: BuildSite, entry: CacheEntry): number {
  return siteCacheLine(project, site, "cache-to", entry);
}

function location(site: BuildSite): string {
  return site.command ? "`--cache-to`" : "`cache-to`";
}

function withScope(entry: CacheEntry, scope: string | undefined, value: string): string {
  if (scope === undefined) return `${entry.text},scope=${value}`;
  return entry.text.replace(`scope=${scope}`, `scope=${scope}-${value}`);
}

function allSites(workflows: WorkflowModel[]): BuildSite[] {
  return workflows.flatMap((workflow) => workflow.jobs.flatMap((job) => jobBuilds(workflow, job)));
}

export default defineRule({
  meta: {
    id: "containers/gha-cache-missing-scope",
    ruleset: "containers",
    description: "Consider distinct gha cache scopes for modeled build variants that can replace each other's cache index.",
    rationale:
      "The gha backend's scope defaults to buildkit. Multiple exports sharing that scope can replace its index within the same repository/branch cache namespace. Some layers, local builder caches or other imports can still be reused; replacement is not proof of rebuilding from scratch. Scope expressions should distinguish relevant image/platform variants and agree across every importer/exporter. That cross-file contract is not established by this detector, so changes require review rather than automatic edits.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.docker.com/build/cache/backends/gha/", "https://docs.docker.com/build/ci/github-actions/cache/#github-cache"],
    impact: "high",
    fixable: false,
    example: {
      bad: "strategy:\n  matrix:\n    platform: [linux/amd64, linux/arm64]\nsteps:\n  - uses: docker/build-push-action@v7\n    with:\n      platforms: ${{ matrix.platform }}\n      cache-from: type=gha\n      cache-to: type=gha,mode=max",
      good: "strategy:\n  matrix:\n    platform: [linux/amd64, linux/arm64]\nsteps:\n  - uses: docker/build-push-action@v7\n    with:\n      platforms: ${{ matrix.platform }}\n      cache-from: type=gha,scope=${{ matrix.platform }}\n      cache-to: type=gha,mode=max,scope=${{ matrix.platform }}",
    },
  },
  check({ project, report }) {
    const reported = new Set<string>();
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        if (!job.matrix) continue;
        const combinations = matrixCombinations(job.matrix);
        if (!combinations || combinations.length < 2) continue;
        const varying = varyingDimensions(job);
        for (const site of jobBuilds(workflow, job)) {
          const referenced = referencedDimensions(job, site.step, site.command?.text).filter((name) => varying === undefined || varying.has(name));
          if (referenced.length === 0) continue;
          for (const entry of cacheTo(site)) {
            if (entry.type !== "gha") continue;
            const scope = entry.attributes.get("scope");
            const scopedDimensions = new Set([...(scope ?? "").matchAll(MATRIX_REFERENCE)].flatMap((match) => match[1] ?? []));
            const missing = referenced.filter((name) => !scopedDimensions.has(name));
            if (missing.length === 0 || (scope !== undefined && isDynamic(scope) && scopedDimensions.size === 0)) continue;
            const resolved = combinations.map((combination) => ({
              scope: matrixText(scope ?? "buildkit", combination),
              variants: referenced.map((name) => JSON.stringify(combination[name])),
            }));
            if (resolved.some((leg) => leg.scope === undefined)) continue;
            if (!resolved.some((leg, index) => resolved.slice(index + 1).some((other) =>
              leg.scope === other.scope && leg.variants.some((value, dimension) => value !== other.variants[dimension]),
            ))) continue;
            const value = missing.map((name) => `\${{ matrix.${name} }}`).join("-");
            const line = entryLine(project, site, entry);
            reported.add(`${workflow.path}:${site.step.key}:${line}`);
            const scoped = withScope(entry, scope, value);
            report({
              path: workflow.path,
              line,
              key: `${job.key}:${site.step.key}:gha-scope-matrix:${line}`,
              message: `${location(site)} entry \`${entry.text}\` ${scope === undefined ? "has no `scope`" : `uses scope \`${scope}\``} in matrix job \`${job.id}\`, but does not visibly distinguish ${missing.map((name) => `\`matrix.${name}\``).join(", ")} used by the build. Variants may replace the same cache index if they share a repository/branch namespace; correlated dimensions or other cache sources may avoid a collision.`,
              suggestion: site.command
                ? `Give each leg its own scope in both flags, e.g. \`--cache-from type=gha,scope=${scope === undefined ? value : `${scope}-${value}`} --cache-to ${scoped}\`.`
                : `Scope the cache per leg in both inputs:\n  cache-from: type=gha,scope=${scope === undefined ? value : `${scope}-${value}`}\n  cache-to: ${scoped}`,
              impact: "high",
              confidence: "medium",
            });
          }
        }
      }
    }

    // Distinct images built repository-wide that all write the default scope.
    const workflows = [...project.workflows, ...project.actions];
    const buildPushCount = workflows.flatMap((workflow) => workflow.jobs.flatMap((job) => job.steps.filter(isBuildPush))).length;
    const candidates: Array<{ site: BuildSite; entry: CacheEntry; line: number; group: string }> = [];
    for (const site of allSites(workflows)) {
      for (const entry of cacheTo(site)) {
        if (entry.type !== "gha" || entry.attributes.has("scope")) continue;
        const line = entryLine(project, site, entry);
        if (reported.has(`${site.workflow.path}:${site.step.key}:${line}`)) continue;
        const dockerfile = siteDockerfile(project, site);
        if (!dockerfile) continue;
        const target = site.command ? site.command.build.flags.get("target")?.[0] : site.step.with.get("target")?.value;
        if (target !== undefined && isDynamic(String(target))) continue;
        candidates.push({ site, entry, line, group: `${dockerfile.path}#${target === undefined ? "" : String(target)}` });
      }
    }
    const groups = new Set(candidates.map((candidate) => candidate.group));
    if (groups.size < 2) return;
    const jobIds = candidates.map((candidate) => candidate.site.job.id);
    for (const { site, entry, line, group } of candidates) {
      if (!site.command && buildPushCount >= 2) continue;
      const others = candidates.filter((candidate) => candidate.group !== group);
      const jobId = site.job.id;
      const scope = /^[A-Za-z0-9._-]+$/.test(jobId) && jobIds.filter((id) => id === jobId).length === 1 ? jobId : undefined;
      const [dockerfile, target] = group.split("#");
      report({
        path: site.workflow.path,
        line,
        key: `${site.job.key}:${site.step.key}:gha-scope-images:${line}`,
        message: `${location(site)} entry \`${entry.text}\` (building ${dockerfile ?? ""}${target ? ` target \`${target}\`` : ""}) has no \`scope\`, and ${others.length} build(s) of a different image (${[...new Set(others.map((other) => other.group.replace(/#$/, "").replace("#", " target ")))].join(", ")}) also export an unscoped gha cache: ${OVERWRITE}. This matters when those exports share an accessible repository/branch cache namespace; other cache sources can still provide reuse.`,
        suggestion: `Give each image its own scope in both cache-from and cache-to, e.g. \`type=gha,scope=${scope ?? "<image>"}\` and \`${entry.text},scope=${scope ?? "<image>"}\`.`,
        impact: "medium",
        confidence: "medium",
        related: others.map((other) => ({ path: other.site.workflow.path, line: other.line })),
      });
    }
  },
});
