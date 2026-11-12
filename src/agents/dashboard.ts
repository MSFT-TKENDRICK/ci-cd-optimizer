import { z } from "zod";
import type { DashboardMetricsProjection } from "../telemetry/dashboard-metrics.js";
import { AgentError } from "./workspace.js";
import { sanitizeMarkdown } from "./safety.js";

export const dashboardLayout = z.strictObject({
  sections: z.array(z.enum(["overview", "jobs", "attribution", "comparison"])).min(1).max(4)
    .refine((value) => new Set(value).size === value.length, "Sections must be unique."),
});
export const defaultDashboardLayout = { sections: ["overview", "jobs", "attribution", "comparison"] as const };

export interface DashboardPageRequest {
  jobId?: number;
  jobOffset?: number;
  stepOffset?: number;
  findingOffset?: number;
  gapOffset?: number;
  evidenceOffset?: number;
}

const page = (offset: number, size: number, total: number) => ({
  offset, total, nextOffset: offset + size < total ? offset + size : null,
});
const text = (value: string) => sanitizeMarkdown(value, 160).text;
const maybeText = (value: string | null) => value === null ? null : text(value);

/** Pages each collection independently so neither large workflows nor evidence silently disappear. */
export function dashboardPage(projection: DashboardMetricsProjection, request: DashboardPageRequest) {
  const { jobId, jobOffset = 0, stepOffset = 0, findingOffset = 0, gapOffset = 0, evidenceOffset = 0 } = request;
  const jobs = jobId === undefined ? projection.jobs : projection.jobs.filter((job) => job.id === jobId);
  if (jobId !== undefined && !jobs.length) throw new AgentError("That job is not present in the collected run.");
  const findings = jobId === undefined ? projection.attribution.findings : projection.attribution.findings.filter((finding) =>
    finding.relatedJobIds?.includes(jobId) || jobs.some((job) => job.key === finding.jobKey));
  const gaps = jobId === undefined ? projection.attribution.gaps : projection.attribution.gaps.filter((gap) => jobs.some((job) => job.key === gap.jobKey));
  const jobPage = jobs.slice(jobOffset, jobOffset + 3).map((job) => ({
    ...job,
    name: text(job.name), key: text(job.key), runnerName: maybeText(job.runnerName),
    labels: job.labels?.slice(0, 5).map(text) ?? null,
    omittedLabels: Math.max(0, (job.labels?.length ?? 0) - 5),
    needs: job.needs.slice(0, 5).map(text), omittedNeeds: Math.max(0, job.needs.length - 5),
    steps: job.steps.slice(stepOffset, stepOffset + 5).map((step) => ({ ...step, name: text(step.name) })),
    stepsTotal: job.steps.length,
    nextStepOffset: page(stepOffset, 5, job.steps.length).nextOffset,
  }));
  const findingPage = findings.slice(findingOffset, findingOffset + 3).map(({ relatedJobIds, ...finding }) => ({
    ...finding,
    scope: relatedJobIds ? "multiple-jobs" : "single-job",
    id: text(finding.id), jobName: text(finding.jobName), jobKey: text(finding.jobKey),
    summary: text(finding.summary), recommendation: text(finding.recommendation),
    evidence: finding.evidence.slice(evidenceOffset, evidenceOffset + 2).map(text),
    evidenceTotal: finding.evidence.length,
    nextEvidenceOffset: page(evidenceOffset, 2, finding.evidence.length).nextOffset,
  }));
  return {
    metrics: {
      ...projection,
      provenance: { ...projection.provenance, owner: text(projection.provenance.owner), repo: text(projection.provenance.repo),
        workflowName: text(projection.provenance.workflowName), workflowPath: maybeText(projection.provenance.workflowPath),
        branch: maybeText(projection.provenance.branch) },
      jobs: jobPage,
      attribution: {
        ...projection.attribution,
        findings: findingPage,
        technologyEvidence: [],
        gaps: gaps.slice(gapOffset, gapOffset + 5).map((gap) => ({
          ...gap, jobKey: text(gap.jobKey), ...(gap.jobName ? { jobName: text(gap.jobName) } : {}), detail: text(gap.detail),
        })),
      },
      reworkExposure: { ...projection.reworkExposure, failedAttemptsDetail: projection.reworkExposure.failedAttemptsDetail.slice(0, 20),
        omittedFailedAttemptsDetail: Math.max(0, projection.reworkExposure.failedAttemptsDetail.length - 20) },
    },
    pages: { jobs: page(jobOffset, 3, jobs.length), findings: page(findingOffset, 3, findings.length), gaps: page(gapOffset, 5, gaps.length) },
  };
}
