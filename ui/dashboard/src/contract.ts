import { z } from "zod/v4";

export const sections = ["overview", "jobs", "attribution", "comparison"] as const;
export const layoutSchema = z.strictObject({
  sections: z.array(z.enum(sections)).min(1).max(sections.length)
    .refine((value) => new Set(value).size === value.length, "Sections must be unique"),
});
export type Layout = z.infer<typeof layoutSchema>;
export const defaultLayout: Layout = { sections: [...sections] };

const duration = z.number().finite().nonnegative().nullable();
const jobSchema = z.object({
  id: z.number().int().nonnegative(), name: z.string(), conclusion: z.string().nullable(),
  startedAt: z.string().nullable(), completedAt: z.string().nullable(), needs: z.array(z.string()),
  omittedNeeds: z.number().int().nonnegative().optional(),
  durationMs: duration, queueMs: duration, readyQueueMs: duration,
  critical: z.boolean().nullable(), slackMs: duration, headroomMs: duration, limitedBy: z.string().nullable(),
  steps: z.array(z.object({ number: z.number(), name: z.string(), conclusion: z.string().nullable(), durationMs: duration,
    startedAt: z.string().nullable(), completedAt: z.string().nullable() })),
  stepsTotal: z.number().int().nonnegative().optional(), nextStepOffset: z.number().int().nonnegative().nullable().optional(),
});
export const projectionSchema = z.object({
  schema: z.literal("cicd-optimizer/dashboard-metrics-v1"),
  provenance: z.object({
    owner: z.string(), repo: z.string(), workflowName: z.string(), runId: z.number(),
    runAttempt: z.number(), headSha: z.string(), event: z.string(), branch: z.string().nullable(),
    conclusion: z.string().nullable(), collectedAt: z.string().nullable(),
  }),
  metrics: z.object({
    queueInclusiveLatencyMs: duration, executionElapsedMs: duration, initialQueueMs: duration,
    observedRunnerWorkMs: duration, completeRunnerWorkMs: duration,
    completeness: z.object({ jobInventory: z.boolean(), runnerWork: z.boolean() }),
  }),
  jobs: z.array(jobSchema),
  attribution: z.object({
    available: z.boolean(),
    logCoverage: z.object({ jobs: z.number(), jobsWithLogs: z.number(), explainedMs: duration, unexplainedMs: duration, observedMs: duration }).nullable(),
    findings: z.array(z.object({ id: z.string(), summary: z.string(), jobName: z.string(), category: z.string(),
      scope: z.enum(["multiple-jobs", "single-job"]).optional(),
      recommendation: z.string(), observedMs: duration, elapsedSavingsBoundMs: duration, runnerSavingsBoundMs: duration, evidence: z.array(z.string()),
      evidenceTotal: z.number().int().nonnegative().optional(), nextEvidenceOffset: z.number().int().nonnegative().nullable().optional() })),
    gaps: z.array(z.object({ kind: z.string(), detail: z.string() })),
  }),
  comparison: z.object({
    sampleCount: z.number().int().nonnegative(), medianExecutionElapsedMs: duration,
    medianInitialQueueMs: duration, examined: z.number().int().nonnegative(),
    comparableRunIds: z.array(z.number()), excluded: z.record(z.string(), z.number().int().nonnegative()), currentProblem: z.string().nullable(),
  }),
  reworkExposure: z.object({
    failedAttempts: z.number().int().nonnegative(), failedAttemptRunnerWorkMs: duration,
    allFailedAttemptInventoriesComplete: z.boolean(),
  }),
});
export type Projection = z.infer<typeof projectionSchema>;
const pageSchema = z.object({ offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() });
export const pagesSchema = z.object({ jobs: pageSchema, findings: pageSchema, gaps: pageSchema });
export type Pages = z.infer<typeof pagesSchema>;
export type PageRequest = { jobId?: number | null; jobOffset?: number | null; stepOffset?: number | null; findingOffset?: number | null; gapOffset?: number | null; evidenceOffset?: number | null };

export function parseResult(result: { isError?: boolean; structuredContent?: unknown }) {
  if (result.isError) throw new Error("The dashboard tool failed. Try refreshing.");
  const content = typeof result.structuredContent === "object" && result.structuredContent !== null
    ? result.structuredContent as Record<string, unknown> : undefined;
  const projection = projectionSchema.safeParse(content?.metrics && typeof content.metrics === "object" && "schema" in content.metrics
    ? content.metrics : content);
  if (!projection.success) throw new Error("The dashboard tool returned missing or invalid evidence.");
  const pages = content?.pages === undefined ? null : pagesSchema.safeParse(content.pages);
  if (pages && !pages.success) throw new Error("The dashboard tool returned invalid pagination.");
  const layout = layoutSchema.safeParse(content?.layout);
  return { projection: projection.data, layout: layout.success ? layout.data : defaultLayout,
    pages: pages?.success ? pages.data : null, invalidLayout: content?.layout !== undefined && !layout.success };
}

export function layoutProgram(layout: Layout): string {
  return `root = Dashboard(${JSON.stringify(layout.sections)})`;
}
