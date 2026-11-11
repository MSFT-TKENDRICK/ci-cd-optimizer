import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { anyUses, commandWords } from "../caching/shared.js";
import { jobBuilds, siteDockerfile, type BuildSite } from "../containers/buildx.js";
import { commandsOf, defineRule } from "../helpers.js";
import { stable, workingDirectory } from "./shared.js";

const BUILD_COMMANDS = [
  /^npm run(?:-script)? build(?:\s|$)/,
  /^(?:pnpm|yarn|bun)(?: run)? build(?:\s|$)/,
  /^go build(?:\s|$)/,
  /^cargo build(?:\s|$)/,
  /^(?:mvn|\.\/mvnw)(?:\s.*)?\s(?:package|install)(?:\s|$)/,
  /^(?:gradle|\.\/gradlew)(?:\s.*)?\sbuild(?:\s|$)/,
  /^dotnet build(?:\s|$)/,
  /^make(?: (?:build|all))?$/,
];

const ARTIFACT_ACTIONS = ["actions/upload-artifact", "actions/download-artifact"];

interface Build {
  job: JobModel;
  line: number;
  command: string;
}

function environment(workflow: WorkflowModel, job: JobModel): string | undefined {
  const runsOn = JSON.stringify(job.runsOn?.value ?? null);
  if (runsOn.includes("${{") || job.matrix !== undefined) return undefined;
  return `${runsOn}\u0000${job.containerImage?.value ?? ""}\u0000${stable(job.env)}\u0000${stable(workflow.env)}`;
}

export default defineRule({
  meta: {
    id: "redundancy/rebuild-per-job",
    ruleset: "redundancy",
    description: "Repeated builds across CI jobs and workflows should be assessed for verified artifact or layer reuse.",
    rationale:
      "Repeated build commands may duplicate work, but matching visible commands and runner labels do not establish equivalent inputs or outputs. The same Dockerfile declared in different workflows is also only a reuse candidate: triggers, revisions, inputs, targets and platforms may differ. Where consumers can safely share a verified immutable artifact or cached layers, building once may reduce repeated work and align their inputs. Artifact transfer, serialization and changed critical paths can offset the saving; validate semantics and measure the result.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/tutorials/store-and-share-data"],
    impact: "medium",
    example: {
      bad: "jobs:\n  test:\n    steps:\n      - run: npm run build\n      - run: npm test\n  e2e:\n    steps:\n      - run: npm run build\n      - run: npm run e2e",
      good: "jobs:\n  build:\n    steps:\n      - run: npm run build\n      - uses: actions/upload-artifact@v4\n        with:\n          name: dist\n          path: dist\n  e2e:\n    needs: build\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: dist\n      - run: npm run e2e",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.jobs.some((job) => anyUses(job.steps, ...ARTIFACT_ACTIONS))) continue;
      const groups = new Map<string, Build[]>();
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const env = environment(workflow, job);
        if (env === undefined) continue;
        const seen = new Set<string>();
        for (const step of job.steps) {
          if (step.if !== undefined) continue;
          for (const { command, line } of commandsOf(step)) {
            if (command.includes("${{")) continue;
            const words = commandWords(command).join(" ");
            if (!BUILD_COMMANDS.some((pattern) => pattern.test(words))) continue;
            const key = `${words}\u0000${workingDirectory(workflow, job, step) ?? ""}\u0000${stable(step.env)}\u0000${env}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const group = groups.get(key) ?? [];
            group.push({ job, line, command: words });
            groups.set(key, group);
          }
        }
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const [first, ...others] = group;
        if (!first) continue;
        report({
          path: workflow.path,
          line: first.line,
          key: `${first.job.key}.rebuild.${first.command}`,
          message: `\`${first.command}\` runs in ${group.length} jobs (${group.map((entry) => entry.job.id).join(", ")}) with no artifact handoff.`,
          suggestion:
            "Build once in a dedicated job, publish the output with actions/upload-artifact, and have the other jobs `needs:` it and use actions/download-artifact.",
          confidence: "medium",
          related: others.map((entry) => ({ path: workflow.path, line: entry.line })),
        });
      }
    }
    const containerBuilds = new Map<string, Map<string, BuildSite>>();
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        for (const site of jobBuilds(workflow, job)) {
          const dockerfile = siteDockerfile(project, site);
          if (!dockerfile) continue;
          const sites = containerBuilds.get(dockerfile.path) ?? new Map<string, BuildSite>();
          if (!sites.has(workflow.path)) sites.set(workflow.path, site);
          containerBuilds.set(dockerfile.path, sites);
        }
      }
    }
    for (const [dockerfile, sites] of containerBuilds) {
      if (sites.size < 2) continue;
      const [first, ...others] = [...sites.values()].sort((a, b) => a.workflow.path.localeCompare(b.workflow.path));
      if (!first) continue;
      report({
        path: first.workflow.path,
        line: first.command?.line ?? first.step.line,
        key: `container-reuse.${dockerfile}`,
        message: `\`${dockerfile}\` is declared as a build input in ${sites.size} workflows; review cross-workflow artifact or layer reuse.`,
        suggestion:
          "Compare the commit, context, target, platform, build arguments, conditions, and side effects before reusing an immutable image by digest. When final images must differ, assess a shared remote layer cache with compatible inputs and trust boundaries. No savings have been measured; validate behavior and measure transfer costs before removing any build.",
        confidence: "low",
        related: others.map((site) => ({ path: site.workflow.path, line: site.command?.line ?? site.step.line })),
      });
    }
  },
});
