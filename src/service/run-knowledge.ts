import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";
import { loadRepositorySnapshot, resolveRepositoryRevision, type RepositoryRevision, type RepositorySnapshot } from "../github/repository.js";
import { extractKnowledge, isKnowledgePath } from "../knowledge/extract.js";
import { inventoryPolicyDigest, validateRevision } from "../knowledge/identity.js";
import { loadKnowledgeIdentity } from "../knowledge/repository.js";
import { createRunObservation } from "../knowledge/run-observation.js";
import { analyzeDurations, describeDurations, type DurationAnalysis, type DurationReport } from "../knowledge/durations.js";
import type { KnowledgeSnapshot, KnowledgeStore, MitigationApplicationEvent, RunObservation } from "../knowledge/types.js";
import type { LintConfig } from "../lint/config.js";
import type { WorkflowSnapshot } from "../telemetry/types.js";
import { refreshMitigationApplications } from "./recipe-knowledge.js";

export interface RunKnowledge {
  observation: RunObservation;
  project?: KnowledgeSnapshot;
  persistence: "saved" | "preview";
  durations?: DurationReport;
  mitigations?: { coverage: "latest-100-applications"; events: MitigationApplicationEvent[] };
}

export interface CollectedRunKnowledge extends RunKnowledge {
  /** Internal statistical inputs; not included in the public result/JSON payload. */
  comparison?: Omit<DurationAnalysis, "report">;
}

/** Only the run-recorded head revision supplies source context; checkout/task execution remains unknown. */
export async function collectRunKnowledge(
  client: GitHubClient, repo: RepoRef, run: WorkflowSnapshot, config: LintConfig,
  options: { store?: KnowledgeStore; expectedRepositoryId?: number; now?: Date } = {},
): Promise<CollectedRunKnowledge> {
  validateRevision(run.headSha);
  const repository = await loadKnowledgeIdentity(client, repo, options.expectedRepositoryId);
  const policy = inventoryPolicyDigest(config);
  const reusableCoverage = ({ coverage }: Pick<KnowledgeSnapshot, "coverage">) =>
    coverage.inventoryPolicyDigest === policy && coverage.inventoryComplete && coverage.declarationsComplete &&
    coverage.truncated.length === 0 && coverage.problems.length === 0;
  let project: KnowledgeSnapshot | undefined;
  let resolvedRevision: RepositoryRevision | undefined;
  try { resolvedRevision = await resolveRepositoryRevision(client, repo, run.headSha); }
  catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }
  if (resolvedRevision && resolvedRevision.sha !== run.headSha) throw new Error("Run source revision changed during collection");
  if (resolvedRevision && options.store) {
    const candidates = await options.store.list({ ...repository, revision: run.headSha, limit: 100 });
    const reusable = candidates.find(reusableCoverage);
    if (reusable) {
      project = await options.store.load(repository, reusable.id);
      if (!project) throw new Error("Previously listed source evidence is unavailable");
      if (project.id !== reusable.id || project.revision !== run.headSha || project.repository.host !== repository.host ||
          project.repository.repositoryId !== repository.repositoryId || !reusableCoverage(project)) {
        throw new Error("Stored source evidence does not match the requested run context");
      }
    }
  }
  if (resolvedRevision && !project) {
    let source: RepositorySnapshot | undefined;
    try { source = await loadRepositorySnapshot(client, repo, { ref: run.headSha, config, pathFilter: isKnowledgePath, resolvedRevision }); }
    catch (error) {
      if (httpStatus(error) !== 404) throw error;
      // A deleted/inaccessible revision is explicit missing context, not an empty successful inventory.
    }
    if (source) {
      if (source.sha !== run.headSha) throw new Error("Run source revision changed during collection");
      // Knowledge has a fixed, narrower inventory. Keep its completeness separate from the linter's input.
      project = extractKnowledge(repository, source.sha, { ...source.input, inventoryComplete: source.selectionComplete }, {
        ignorePaths: config.ignorePaths, truncated: source.input.truncated, inventoryPolicyDigest: policy,
        ...(options.now ? { now: options.now } : {}),
      });
    }
  }
  const observation = createRunObservation(repository, run,
    project ? { status: "linked", snapshotId: project.id } : { status: "unavailable", reason: "revision-unavailable" }, options.now,
  );
  if (options.store) await options.store.saveRunObservation(observation, project);
  let mitigations: RunKnowledge["mitigations"];
  if (options.store && project && config.recipes.enabled) {
    const applications = (await options.store.listMitigationApplications(repository, 100))
      .filter((application) => application.change.kind !== "commit");
    mitigations = {
      coverage: "latest-100-applications",
      events: await refreshMitigationApplications(client, repo, options.store, applications),
    };
  }
  const window = options.store ? await options.store.readRunWindow({
    ...repository, workflowId: run.workflowId, branch: run.branch, referenceRunId: run.runId, limit: 100,
  }) : { complete: false, groups: [{ runId: run.runId, complete: true, observations: [observation] }] };
  const { report: durations, ...comparison } = analyzeDurations(observation, window, config.durations);
  return {
    observation, ...(project ? { project } : {}), persistence: options.store ? "saved" : "preview", durations,
    ...(mitigations ? { mitigations } : {}),
    ...(options.store ? { comparison } : {}),
  };
}

export function describeRunKnowledge(knowledge: RunKnowledge): string {
  const evidence = knowledge.project;
  const context = evidence
    ? `At the run-recorded source revision \`${evidence.revision}\`: ${evidence.projects.length} project nodes and ${evidence.technologies.length} technology declarations.`
    : "Source content could not be read at the run-recorded revision; project and technology context is unknown.";
  const coverage = !evidence ? "" : evidence.coverage.inventoryComplete && evidence.coverage.declarationsComplete
    ? " Collection is complete within the supported, configured inventory; configured ignores still apply."
    : " Collection is partial or uncertain; missing declarations do not establish absence.";
  return `\n\n### Project declaration context\n\n${context}${coverage} This does not identify executed projects, installed tool versions, cache use, or a causal optimization benefit.\n\nKnowledge evidence: ${knowledge.persistence === "saved" ? "persisted" : "preview only (no knowledge database writes; durable duration history was not queried)"}.` +
    (knowledge.durations ? describeDurations(knowledge.durations) : "") +
    (knowledge.mitigations?.events.length
      ? `\n\n### Recorded mitigation lifecycle\n\nRefreshed ${knowledge.mitigations.events.length} pinned PR/issue applications from the latest 100 records. ` +
        `${knowledge.mitigations.events.filter((event) => event.state === "applied").length} report merged proposals; ` +
        `${knowledge.mitigations.events.filter((event) => event.state === "unknown").length} remain unknown. ` +
        "Merges and closed issues are not evidence of performance benefit. Use authorized knowledge inspection and explicit run comparisons for outcome evidence."
      : "");
}
