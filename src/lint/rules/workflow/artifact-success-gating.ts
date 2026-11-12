import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, scalarValue, toJS } from "../../parsers/yaml.js";
import { defineRule } from "../helpers.js";
import { jobNode, stepNode } from "../testing/shared.js";
import { ancestors } from "../triggers/shared.js";

function successOnly(condition: string | undefined): boolean {
  const expression = condition?.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1").replace(/\s+/g, "");
  return expression === undefined || expression === "success()" || expression === "true";
}

function allowsFailure(workflow: WorkflowModel, job: JobModel, step?: StepModel): boolean {
  const entry = field(workflow.source, step ? stepNode(workflow.source, step) : jobNode(workflow.source, job), "continue-on-error");
  return entry !== undefined && scalarValue(entry.value) !== false;
}

function artifactName(step: StepModel, upload: boolean): string | undefined {
  const name = step.with.get("name");
  if (!name) return upload ? "artifact" : undefined;
  return name.kind === "literal" && typeof name.value === "string" && name.value.trim() !== ""
    ? name.value : undefined;
}

function handlesOutcomes(workflow: WorkflowModel, job: JobModel): boolean {
  const seen = new Set<object>();
  function inspect(value: unknown): boolean {
    if (typeof value === "string") {
      return /\bneeds\s*(?:\.|\[)|\btoJSON\s*\(\s*needs\b|\b(?:always|failure|cancelled)\s*\(/i.test(value);
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(inspect);
  }
  return inspect(toJS(workflow.source, jobNode(workflow.source, job)));
}

interface Producer {
  job: JobModel;
  step: StepModel;
}

export default defineRule({
  meta: {
    id: "workflow/artifact-success-gating",
    ruleset: "workflow",
    description: "Success-gate same-run artifact consumers on their producer jobs.",
    rationale:
      "A literal artifact upload/download pair identifies a data prerequisite, unlike job names. Without a needs path, the consumer can start before the producer finishes, or continue after its failure. An artifact may already exist when a later producer step fails. GitHub needs skips dependent jobs after failure through the dependency chain; it cannot cancel independent work already running. Review the artifact contract before adding a direct needs edge; do not serialize unrelated checks or restrict intentional failure handlers and required-check aggregates. These warnings identify a static gating gap, not measured waste or guaranteed removable runner minutes.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    fixable: false,
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds",
      "https://docs.github.com/en/actions/tutorials/store-and-share-data",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions",
    ],
    impact: "high",
    example: {
      bad: "jobs:\n  producer:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          name: dist\n          path: dist\n  consumer:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: dist",
      good: "jobs:\n  producer:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          name: dist\n          path: dist\n  consumer:\n    needs: producer\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: dist",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const producers = new Map<string, Producer[]>();
      let unknownUpload = false;
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (step.uses?.action.name !== "actions/upload-artifact") continue;
          const name = artifactName(step, true);
          if (name === undefined) unknownUpload = true;
          else producers.set(name, [...(producers.get(name) ?? []), { job, step }]);
        }
      }
      if (unknownUpload) continue;
      for (const job of workflow.jobs) {
        // Failure handlers and aggregates need their own result policy, not a blanket success gate.
        if (!successOnly(job.if) || handlesOutcomes(workflow, job) || allowsFailure(workflow, job)) continue;
        const dependencies = ancestors(workflow, job);
        const reported = new Set<string>();
        for (const step of job.steps) {
          if (step.uses?.action.name !== "actions/download-artifact" || !successOnly(step.if)) continue;
          if (allowsFailure(workflow, job, step)) continue;
          if (["run-id", "repository", "github-token", "artifact-ids", "pattern"].some((key) => step.with.has(key))) continue;
          const name = artifactName(step, false);
          if (name === undefined) continue;
          const candidates = producers.get(name);
          if (candidates?.length !== 1) continue;
          const producer = candidates[0];
          if (!producer || producer.job === job || producer.job.matrix || producer.job.uses) continue;
          if (!successOnly(producer.job.if) || !successOnly(producer.step.if)) continue;
          if (allowsFailure(workflow, producer.job) || allowsFailure(workflow, producer.job, producer.step)) continue;
          if (dependencies.includes(producer.job) || ancestors(workflow, producer.job).includes(job) || reported.has(producer.job.id)) continue;
          reported.add(producer.job.id);
          report({
            path: workflow.path,
            line: step.uses.line,
            key: `${job.key}.artifact-success-gating.${producer.job.id}`,
            message: `Job \`${job.id}\` downloads artifact \`${name}\` uploaded by \`${producer.job.id}\`, but has no needs path to that producer. It can run without waiting for producer success, including after a producer failure.`,
            suggestion: `If this artifact is required success-path input, add \`${producer.job.id}\` to \`${job.id}\`'s direct needs (preserve existing dependencies). Verify all triggers, failure/skip paths and artifact availability first. Keep cleanup, diagnostics and required-check aggregation able to run and propagate failures; do not apply this gate to intentional failure handlers. No autofix or runner-minute savings estimate is provided.`,
            related: [{ path: workflow.path, line: producer.step.uses?.line ?? producer.step.line }],
            confidence: "high",
          });
        }
      }
    }
  },
});
