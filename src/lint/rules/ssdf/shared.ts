import { commandsOf, steps } from "../helpers.js";
import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";

const RELEASE_ACTIONS = new Set(["softprops/action-gh-release", "ncipollo/release-action", "actions/upload-release-asset"]);

export interface PublishStep {
  workflow: WorkflowModel;
  job: JobModel;
  step: JobModel["steps"][number];
  description: string;
}

export function publishSteps(project: ProjectModel): PublishStep[] {
  const found: PublishStep[] = [];
  for (const { workflow, job, step } of steps(project.workflows)) {
    const action = step.uses?.action?.name ?? "";
    const command = commandsOf(step).map(({ command: value }) => value).join("\n");
    const withInputs = new Map([...step.with].map(([key, value]) => [key.toLowerCase(), String(value.value ?? "")]));
    let description: string | undefined;

    if (action === "docker/build-push-action" && /^(?:true|yes|1)$/i.test(withInputs.get("push") ?? "")) description = "container image";
    else if (RELEASE_ACTIONS.has(action)) description = "release artifact";
    else if (/\bdocker\s+push\b|\bbuildah\s+push\b|\bpodman\s+push\b/i.test(command)) description = "container image";
    else if (/\b(?:npm|pnpm|yarn)\s+publish\b|\bnpm\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgh\s+release\s+upload\b/i.test(command)) description = "package or release";
    if (description) found.push({ workflow, job, step, description });
  }
  return found;
}

export function hasProvenanceEvidence(job: JobModel): boolean {
  return job.steps.some((step) => {
    const action = step.uses?.action?.name ?? "";
    const command = commandsOf(step).map(({ command: value }) => value).join("\n");
    const withInputs = new Map([...step.with].map(([key, value]) => [key.toLowerCase(), String(value.value ?? "")]));
    return (
      action === "actions/attest-build-provenance" ||
      action === "actions/attest" ||
      action === "slsa-framework/slsa-github-generator" ||
      (action === "docker/build-push-action" && /^(?:true|yes|1)$/i.test(withInputs.get("provenance") ?? "")) ||
      /\bcosign\s+(?:attest|sign)\b|\bnpm\s+publish\b.*--provenance\b/i.test(command) ||
      /^(?:true|1|yes)$/i.test(String(step.env.NPM_CONFIG_PROVENANCE ?? ""))
    );
  });
}

export function hasSbomEvidence(job: JobModel): boolean {
  return job.steps.some((step) => {
    const action = step.uses?.action?.name ?? "";
    const command = commandsOf(step).map(({ command: value }) => value).join("\n");
    const withInputs = new Map([...step.with].map(([key, value]) => [key.toLowerCase(), String(value.value ?? "")]));
    return (
      action === "anchore/sbom-action" ||
      (action === "docker/build-push-action" && /^(?:true|yes|1)$/i.test(withInputs.get("sbom") ?? "")) ||
      /\b(?:syft|cyclonedx|npm\s+sbom)\b|\btrivy\b.*\b(?:cyclonedx|spdx)\b/i.test(command)
    );
  });
}

export function stepLocation(entry: PublishStep): { path: string; line: number } {
  return { path: entry.workflow.path, line: entry.step.uses?.line ?? entry.step.run?.line ?? entry.step.line };
}
