import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";
import { loadRepositorySnapshot, type RepositorySnapshot } from "../github/repository.js";
import { extractKnowledge, isKnowledgePath } from "../knowledge/extract.js";
import { inventoryPolicyDigest, validateRevision } from "../knowledge/identity.js";
import { loadKnowledgeIdentity } from "../knowledge/repository.js";
import { createRunObservation } from "../knowledge/run-observation.js";
import type { KnowledgeSnapshot, KnowledgeStore, RunObservation } from "../knowledge/types.js";
import type { LintConfig } from "../lint/config.js";
import type { WorkflowSnapshot } from "../telemetry/types.js";

export interface RunKnowledge {
  observation: RunObservation;
  project?: KnowledgeSnapshot;
  persistence: "saved" | "preview";
}

/** Only the run-recorded head revision supplies source context; checkout/task execution remains unknown. */
export async function collectRunKnowledge(
  client: GitHubClient, repo: RepoRef, run: WorkflowSnapshot, config: LintConfig,
  options: { store?: KnowledgeStore; expectedRepositoryId?: number; now?: Date } = {},
): Promise<RunKnowledge> {
  validateRevision(run.headSha);
  const repository = await loadKnowledgeIdentity(client, repo, options.expectedRepositoryId);
  const policy = inventoryPolicyDigest(config);
  const reusableCoverage = ({ coverage }: Pick<KnowledgeSnapshot, "coverage">) =>
    coverage.inventoryPolicyDigest === policy && coverage.inventoryComplete && coverage.declarationsComplete &&
    coverage.truncated.length === 0 && coverage.problems.length === 0;
  let project: KnowledgeSnapshot | undefined;
  if (options.store) {
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
  if (!project) {
    let source: RepositorySnapshot | undefined;
    try { source = await loadRepositorySnapshot(client, repo, { ref: run.headSha, config, pathFilter: isKnowledgePath }); }
    catch (error) {
      if (httpStatus(error) !== 404) throw error;
      // A deleted/inaccessible revision is explicit missing context, not an empty successful inventory.
    }
    if (source) {
      if (source.sha !== run.headSha) throw new Error("Run source revision changed during collection");
      project = extractKnowledge(repository, source.sha, source.input, {
        ignorePaths: config.ignorePaths, truncated: source.input.truncated, inventoryPolicyDigest: policy,
        ...(options.now ? { now: options.now } : {}),
      });
    }
  }
  const observation = createRunObservation(repository, run,
    project ? { status: "linked", snapshotId: project.id } : { status: "unavailable", reason: "revision-unavailable" }, options.now,
  );
  if (options.store) await options.store.saveRunObservation(observation, project);
  return { observation, ...(project ? { project } : {}), persistence: options.store ? "saved" : "preview" };
}

export function describeRunKnowledge(knowledge: RunKnowledge): string {
  const evidence = knowledge.project;
  const context = evidence
    ? `At the run-recorded source revision \`${evidence.revision}\`: ${evidence.projects.length} project nodes and ${evidence.technologies.length} technology declarations.`
    : "Source content could not be read at the run-recorded revision; project and technology context is unknown.";
  return `\n\n### Project declaration context\n\n${context} This does not identify executed projects, installed tool versions, cache use, or a causal optimization benefit.\n\nKnowledge evidence: ${knowledge.persistence === "saved" ? "persisted" : "preview only (no knowledge database writes)"}.`;
}
