import { mannWhitneyGreater, median } from "../alerts/stats.js";
import { comparisonKey, comparisonProblem, jobComparisonContext } from "../telemetry/context.js";
import type { Recipe } from "../recipes/recipe.js";
import { hash, identity, validateScope } from "./identity.js";
import { runtimeFactsIdentity, validateRunObservation } from "./run-observation.js";
import type {
  MitigationApplication, MitigationApplicationEvent, MitigationDefinition, MitigationEvaluation,
  MitigationEvaluationOutcome, MitigationRisk, RunObservation, Technology,
} from "./types.js";

const TECHNOLOGIES: readonly Technology[] = [
  "node", "npm", "pnpm", "yarn", "bun", "typescript", "nx", "turborepo", "lerna", "rush", "bazel", "pants", "gradle",
];
const RISKS: readonly MitigationRisk[] = ["low", "medium", "high"];
const STATES = ["proposed", "applied", "reverted", "declined", "failed", "unknown"] as const;
const OUTCOMES = ["observed-faster", "observed-slower", "no-detected-difference", "inconclusive", "unknown"] as const;
const timestamp = (value: string) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Mitigation evidence timestamp is invalid");
};
const text = (value: string, field: string, maximum: number, allowEmpty = false) => {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim()) ||
      [...value].some((character) => character.charCodeAt(0) < 32 && character !== "\n" && character !== "\t" || character.charCodeAt(0) === 127)) {
    throw new Error(`Mitigation ${field} is invalid`);
  }
};
const uniqueStrings = (values: readonly string[], field: string, maximum: number, countMaximum: number) => {
  if (!Array.isArray(values) || values.length > countMaximum || new Set(values).size !== values.length) throw new Error(`Mitigation ${field} must be a bounded unique list`);
  for (const value of values) text(value, field, maximum);
};

function definitionContent(definition: Omit<MitigationDefinition, "id" | "contentDigest"> | MitigationDefinition) {
  const { version, source, key, revision, title, summary, instructions, risk, rules, files, technologies, contraindications, provenance } = definition;
  return {
    version, source: version === 1 ? source : { host: source.host, repositoryId: source.repositoryId },
    key, revision, title, summary, instructions, risk, rules, files, technologies, contraindications,
    provenance, patchDigest: definition.patchDigest,
  };
}

export function mitigationDefinitionDigest(definition: Omit<MitigationDefinition, "id" | "contentDigest"> | MitigationDefinition): string {
  return identity([`mitigation-content-v${definition.version}`, definitionContent(definition)]);
}

export function equivalentMitigationDefinitions(left: MitigationDefinition, right: MitigationDefinition): boolean {
  return mitigationDefinitionDigest({ ...left, version: 2 }) === mitigationDefinitionDigest({ ...right, version: 2 });
}

/** Imports only explicit recipe selectors; prose and legacy compatibility counters never become success evidence. */
export function mitigationDefinitionFromRecipe(source: MitigationDefinition["source"], recipe: Recipe): MitigationDefinition {
  return createMitigationDefinition({
    source, key: recipe.id, revision: recipe.revision, title: recipe.title, summary: recipe.summary,
    instructions: recipe.instructions, risk: recipe.risk, rules: [...recipe.rules].sort(), files: [...recipe.files].sort(),
    technologies: [], contraindications: [],
    patchDigest: hash(recipe.patch ?? ""),
    provenance: {
      experiment: recipe.source.experiment, arm: recipe.source.arm,
      ...(recipe.source.pullRequest !== undefined ? { pullRequest: recipe.source.pullRequest } : {}),
    },
  });
}

export function mitigationDefinitionIdentity(definition: Omit<MitigationDefinition, "id"> | MitigationDefinition): string {
  return identity([`mitigation-definition-v${definition.version}`, definition.source.host, definition.source.repositoryId,
    definition.key, definition.revision, definition.contentDigest]);
}

export function createMitigationDefinition(
  input: Omit<MitigationDefinition, "version" | "id" | "contentDigest">,
): MitigationDefinition {
  const body = structuredClone({ ...input, version: 2 as const });
  const contentDigest = mitigationDefinitionDigest(body);
  const definition = { ...body, contentDigest, id: mitigationDefinitionIdentity({ ...body, contentDigest }) };
  validateMitigationDefinition(definition);
  return definition;
}

export function validateMitigationDefinition(definition: MitigationDefinition): void {
  validateScope(definition.source);
  if (![1, 2].includes(definition.version) || !Number.isSafeInteger(definition.revision) || definition.revision < 1 ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(definition.key) || !/^[a-f0-9]{64}$/.test(definition.patchDigest)) {
    throw new Error("Mitigation definition identity is invalid");
  }
  text(definition.title, "title", 256);
  text(definition.summary, "summary", 4000);
  text(definition.instructions, "instructions", 20_000);
  if (!RISKS.includes(definition.risk)) throw new Error("Mitigation risk is invalid");
  uniqueStrings(definition.rules, "rules", 160, 100);
  uniqueStrings(definition.files, "files", 1024, 100);
  uniqueStrings(definition.contraindications, "contraindications", 2000, 100);
  if (!Array.isArray(definition.technologies) || definition.technologies.some((technology) => !TECHNOLOGIES.includes(technology)) ||
      new Set(definition.technologies).size !== definition.technologies.length) throw new Error("Mitigation technologies are invalid");
  const provenance = definition.provenance;
  if (provenance.experiment !== undefined) text(provenance.experiment, "experiment provenance", 128);
  if (provenance.arm !== undefined) text(provenance.arm, "arm provenance", 128);
  if (provenance.pullRequest !== undefined && (!Number.isSafeInteger(provenance.pullRequest) || provenance.pullRequest < 1)) {
    throw new Error("Mitigation pull request provenance is invalid");
  }
  if (definition.contentDigest !== mitigationDefinitionDigest(definition) ||
      definition.id !== mitigationDefinitionIdentity(definition)) throw new Error("Mitigation definition identity does not match its content");
}

export function mitigationApplicationIdentity(application: Omit<MitigationApplication, "id"> | MitigationApplication): string {
  return identity(["mitigation-application-v1", application.target.host, application.target.repositoryId,
    application.definitionId, application.topologySnapshotId, application.projectIds, application.change]);
}

export function createMitigationApplication(input: Omit<MitigationApplication, "version" | "id">): MitigationApplication {
  const body = structuredClone({ version: 1 as const, ...input, projectIds: [...input.projectIds].sort() });
  const application = { ...body, id: mitigationApplicationIdentity(body) };
  validateMitigationApplication(application);
  return application;
}

export function validateMitigationApplication(application: MitigationApplication): void {
  validateScope(application.target);
  if (application.version !== 1 || !/^[a-f0-9]{64}$/.test(application.definitionId) ||
      !/^[a-f0-9]{64}$/.test(application.topologySnapshotId)) throw new Error("Mitigation application identity is invalid");
  uniqueStrings(application.projectIds, "project identities", 64, 10_000);
  if (application.projectIds.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error("Mitigation project identity is invalid");
  if (application.projectIds.some((id, index) => index > 0 && application.projectIds[index - 1]! > id)) {
    throw new Error("Mitigation project identities must be sorted");
  }
  if (application.change.kind === "commit") {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(application.change.sha)) throw new Error("Mitigation commit SHA is invalid");
  } else if (application.change.kind === "issue") {
    if (!Number.isSafeInteger(application.change.number) || application.change.number < 1) throw new Error("Mitigation issue reference is invalid");
  } else if (application.change.kind === "pull-request") {
    if (!Number.isSafeInteger(application.change.number) || application.change.number < 1 ||
        (application.change.headSha !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(application.change.headSha))) {
      throw new Error("Mitigation pull request reference is invalid");
    }
  } else throw new Error("Mitigation change kind is invalid");
  timestamp(application.createdAt);
  if (application.id !== mitigationApplicationIdentity(application)) throw new Error("Mitigation application identity does not match its content");
}

export function mitigationApplicationEventIdentity(event: Omit<MitigationApplicationEvent, "id"> | MitigationApplicationEvent): string {
  return identity([`mitigation-application-event-v${event.version}`, event.version, event.target, event.applicationId,
    event.state, ...(event.version === 1 ? [] : [event.observedAt]), event.runObservationId ?? null, event.note ?? null]);
}

export function createMitigationApplicationEvent(
  input: Omit<MitigationApplicationEvent, "version" | "id">,
): MitigationApplicationEvent {
  timestamp(input.observedAt);
  const body = structuredClone({
    ...input, version: 2 as const, target: { host: input.target.host, repositoryId: input.target.repositoryId },
    observedAt: new Date(input.observedAt).toISOString(),
  });
  const event = { ...body, id: mitigationApplicationEventIdentity(body) };
  validateMitigationApplicationEvent(event);
  return event;
}

export function validateMitigationApplicationEvent(event: MitigationApplicationEvent): void {
  validateScope(event.target);
  if (![1, 2].includes(event.version) || !/^[a-f0-9]{64}$/.test(event.applicationId) ||
      !(STATES as readonly string[]).includes(event.state)) throw new Error("Mitigation application event is invalid");
  timestamp(event.observedAt);
  if (event.runObservationId !== undefined && !/^[a-f0-9]{64}$/.test(event.runObservationId)) throw new Error("Mitigation event run identity is invalid");
  if (event.note !== undefined) text(event.note, "event note", 4000, true);
  if (event.id !== mitigationApplicationEventIdentity(event)) throw new Error("Mitigation application event identity does not match its content");
}

export function mitigationEvaluationIdentity(evaluation: Omit<MitigationEvaluation, "id"> | MitigationEvaluation): string {
  const facts = { ...evaluation };
  Reflect.deleteProperty(facts, "id");
  Reflect.deleteProperty(facts, "evaluatedAt");
  return identity(["mitigation-evaluation-v1", facts]);
}

export function createMitigationEvaluation(input: Omit<MitigationEvaluation, "version" | "id">): MitigationEvaluation {
  const body = structuredClone({
    version: 1 as const, ...input,
    controlObservationIds: [...input.controlObservationIds].sort(),
    treatmentObservationIds: [...input.treatmentObservationIds].sort(),
  });
  const evaluation = { ...body, id: mitigationEvaluationIdentity(body) };
  validateMitigationEvaluation(evaluation);
  return evaluation;
}

export function validateMitigationEvaluation(evaluation: MitigationEvaluation): void {
  validateScope(evaluation.target);
  if (evaluation.version !== 1 || !/^[a-f0-9]{64}$/.test(evaluation.applicationId) ||
      !(OUTCOMES as readonly string[]).includes(evaluation.outcome) ||
      evaluation.method !== "distinct-run-mann-whitney-2s-v1") throw new Error("Mitigation evaluation identity or policy is invalid");
  timestamp(evaluation.evaluatedAt);
  if (evaluation.metric.kind === "workflow-duration") {
    if (evaluation.metric.key !== "workflow") throw new Error("Workflow duration metric key must be 'workflow'");
  } else if (evaluation.metric.kind === "job-duration") text(evaluation.metric.key, "job metric key", 1000);
  else throw new Error("Mitigation evaluation metric is invalid");
  if (!/^[a-f0-9]{64}$/.test(evaluation.contextKey)) throw new Error("Mitigation comparison context key is invalid");
  if (!Number.isFinite(evaluation.alpha) || evaluation.alpha <= 0 || evaluation.alpha > 0.1) throw new Error("Mitigation evaluation alpha must be in (0, 0.1]");
  for (const [field, ids] of [["control", evaluation.controlObservationIds], ["treatment", evaluation.treatmentObservationIds]] as const) {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
        new Set(ids).size !== ids.length) throw new Error(`Mitigation ${field} observations must be bounded unique identities`);
  }
  if (evaluation.controlObservationIds.some((id) => evaluation.treatmentObservationIds.includes(id))) {
    throw new Error("Mitigation evaluation samples must not overlap");
  }
  for (const ids of [evaluation.controlObservationIds, evaluation.treatmentObservationIds]) {
    if (ids.some((id, index) => index > 0 && ids[index - 1]! > id)) throw new Error("Mitigation evaluation sample identities must be sorted");
  }
  uniqueStrings(evaluation.limitations, "evaluation limitations", 2000, 100);
  for (const [field, value] of [["control median", evaluation.controlMedianMs], ["treatment median", evaluation.treatmentMedianMs]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`Mitigation ${field} must be finite and nonnegative`);
  }
  if (evaluation.pValue !== undefined &&
      (!Number.isFinite(evaluation.pValue) || evaluation.pValue < 0 || evaluation.pValue > 1)) {
    throw new Error("Mitigation p-value must be finite and between 0 and 1");
  }
  const measuredOutcome: readonly MitigationEvaluationOutcome[] = ["observed-faster", "observed-slower", "no-detected-difference"];
  if (measuredOutcome.includes(evaluation.outcome)) {
    if (evaluation.controlObservationIds.length < 2 || evaluation.treatmentObservationIds.length < 2 ||
        !Number.isFinite(evaluation.controlMedianMs) || !Number.isFinite(evaluation.treatmentMedianMs) ||
        (evaluation.controlMedianMs ?? -1) < 0 || (evaluation.treatmentMedianMs ?? -1) < 0 ||
        !Number.isFinite(evaluation.pValue) || (evaluation.pValue ?? -1) < 0 ||
        (evaluation.pValue ?? 2) > 1) throw new Error("Measured mitigation outcomes require two distinct runs per side and finite statistics");
    const faster = evaluation.treatmentMedianMs! < evaluation.controlMedianMs! &&
      evaluation.pValue! < evaluation.alpha;
    const slower = evaluation.treatmentMedianMs! > evaluation.controlMedianMs! &&
      evaluation.pValue! < evaluation.alpha;
    if ((evaluation.outcome === "observed-faster" && !faster) ||
        (evaluation.outcome === "observed-slower" && !slower) ||
        (evaluation.outcome === "no-detected-difference" && evaluation.pValue! < evaluation.alpha)) {
      throw new Error("Mitigation evaluation outcome conflicts with its recorded statistics");
    }
  } else if (evaluation.outcome === "unknown" &&
      (evaluation.controlObservationIds.length > 0 || evaluation.treatmentObservationIds.length > 0 ||
       evaluation.controlMedianMs !== undefined || evaluation.treatmentMedianMs !== undefined || evaluation.pValue !== undefined)) {
    throw new Error("Unknown mitigation evaluations cannot contain measured samples or statistics");
  }
  if (evaluation.id !== mitigationEvaluationIdentity(evaluation)) throw new Error("Mitigation evaluation identity does not match its content");
}

export function assessMitigation(input: {
  application: MitigationApplication;
  control: readonly RunObservation[];
  treatment: readonly RunObservation[];
  metric: MitigationEvaluation["metric"];
  alpha?: number;
  evaluatedAt?: string;
  appliedAt?: string;
  limitations?: string[];
}): MitigationEvaluation {
  const { application } = input;
  validateMitigationApplication(application);
  const control = uniqueRuns(input.control, "control", application);
  const treatment = uniqueRuns(input.treatment, "treatment", application);
  if (control.length === 0 || treatment.length === 0) throw new Error("Mitigation assessment requires observations on both sides");
  const controlRunIds = new Set(control.map(({ run }) => run.runId));
  if (treatment.some(({ run }) => controlRunIds.has(run.runId))) {
    throw new Error("Mitigation control and treatment samples must use distinct logical runs");
  }
  const samples = [...control, ...treatment];
  const context = comparisonKey(samples[0]!.run);
  if (!context || samples.some(({ run }) => comparisonKey(run) !== context)) {
    throw new Error("Mitigation assessment requires the same eligible workload context");
  }
  const appliedAt = Date.parse(input.appliedAt ?? application.createdAt);
  if (control.some(({ run }) => Date.parse(run.completedAt) > appliedAt) ||
      treatment.some(({ run }) => Date.parse(run.startedAt) < appliedAt)) {
    throw new Error("Mitigation control and treatment observations must bracket the application");
  }
  const metricValue = (observation: RunObservation): number => {
    if (input.metric.kind === "workflow-duration") {
      if (input.metric.key !== "workflow") throw new Error("Workflow duration metric key must be 'workflow'");
      return observation.run.durationMs;
    }
    if (input.metric.kind !== "job-duration") throw new Error("Mitigation duration metric is invalid");
    const jobs = observation.run.jobs.filter((job) => job.conclusion === "success" && jobComparisonContext(job) === input.metric.key);
    if (jobs.length !== 1) throw new Error("Mitigation job metric must identify exactly one comparable job");
    return jobs[0]!.durationMs;
  };
  const before = control.map(metricValue);
  const after = treatment.map(metricValue);
  const evaluatedAt = Date.parse(input.evaluatedAt ?? new Date().toISOString());
  if ([...control, ...treatment].some((observation) => Date.parse(observation.run.completedAt) > evaluatedAt)) {
    throw new Error("Mitigation evaluation must follow every measured run");
  }
  const alpha = input.alpha ?? 0.05;
  let controlMedianMs: number | undefined;
  let treatmentMedianMs: number | undefined;
  let pValue: number | undefined;
  let outcome: MitigationEvaluationOutcome = "inconclusive";
  if (before.length >= 2 && after.length >= 2) {
    controlMedianMs = median(before);
    treatmentMedianMs = median(after);
    const lowerTail = mannWhitneyGreater(after, before).pValue;
    const upperTail = mannWhitneyGreater(before, after).pValue;
    pValue = Math.min(1, 2 * Math.min(lowerTail, upperTail));
    outcome = pValue >= alpha ? "no-detected-difference"
      : controlMedianMs === treatmentMedianMs ? "inconclusive"
        : controlMedianMs > treatmentMedianMs ? "observed-faster" : "observed-slower";
  }
  return createMitigationEvaluation({
    target: { host: application.target.host, repositoryId: application.target.repositoryId },
    applicationId: application.id,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    outcome,
    metric: structuredClone(input.metric),
    method: "distinct-run-mann-whitney-2s-v1",
    contextKey: context,
    alpha,
    controlObservationIds: control.map(({ id }) => id).sort(),
    treatmentObservationIds: treatment.map(({ id }) => id).sort(),
    ...(controlMedianMs !== undefined ? { controlMedianMs } : {}),
    ...(treatmentMedianMs !== undefined ? { treatmentMedianMs } : {}),
    ...(pValue !== undefined ? { pValue } : {}),
    limitations: [...new Set([
      "Observational comparison; does not establish causality.",
      "Run independence and unchanged workloads are not established; sample selection and repeated comparisons are not corrected.",
      ...(input.limitations ?? []),
    ])].sort(),
  });
}

export function verifyMitigationEvaluation(
  application: MitigationApplication,
  evaluation: MitigationEvaluation,
  events: readonly MitigationApplicationEvent[],
  observations: readonly RunObservation[],
): void {
  validateMitigationApplication(application);
  validateMitigationEvaluation(evaluation);
  for (const event of events) {
    validateMitigationApplicationEvent(event);
    if (event.applicationId !== application.id || event.target.host !== application.target.host ||
        event.target.repositoryId !== application.target.repositoryId || Date.parse(event.observedAt) < Date.parse(application.createdAt)) {
      throw new Error("Mitigation event does not match its indexed application or timeline");
    }
  }
  if (evaluation.applicationId !== application.id || evaluation.target.host !== application.target.host ||
      evaluation.target.repositoryId !== application.target.repositoryId) {
    throw new Error("Mitigation evaluation does not match its application scope");
  }
  const at = Date.parse(evaluation.evaluatedAt);
  const stateEvent = events.filter((event) => Date.parse(event.observedAt) <= at)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id))[0];
  if (stateEvent && evaluation.outcome !== "unknown" &&
      events.some((event) => Date.parse(event.observedAt) === Date.parse(stateEvent.observedAt) && event.state !== stateEvent.state)) {
    throw new Error("Mitigation evaluation has ambiguous application state evidence");
  }
  if (stateEvent?.state !== "applied") {
    if (evaluation.outcome === "unknown" && evaluation.controlObservationIds.length === 0 &&
        evaluation.treatmentObservationIds.length === 0) return;
    throw new Error("Measured mitigation evaluation requires an applied state at its evaluation time");
  }
  if (evaluation.outcome === "unknown") return;
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  const control = evaluation.controlObservationIds.map((id) => observationById.get(id));
  const treatment = evaluation.treatmentObservationIds.map((id) => observationById.get(id));
  if (control.some((observation) => !observation) || treatment.some((observation) => !observation)) {
    throw new Error("Mitigation evaluation references unavailable run evidence");
  }
  const selected = [...control, ...treatment] as RunObservation[];
  const selectedRunIds = new Set(selected.map(({ run }) => run.runId));
  if (selectedRunIds.size !== selected.length) throw new Error("Mitigation evaluation samples must use distinct logical runs");
  const runtime = new Map<number, string>();
  for (const observation of observations) {
    if (!selectedRunIds.has(observation.run.runId)) continue;
    validateRunObservation(observation);
    if (observation.repository.host !== evaluation.target.host ||
        observation.repository.repositoryId !== evaluation.target.repositoryId) throw new Error("Mitigation run evidence does not match its indexed scope");
    if (observation.run.runAttempt !== 1) throw new Error("Mitigation evaluation excludes logical runs with retries");
    const identity = runtimeFactsIdentity(observation.run);
    const prior = runtime.get(observation.run.runId);
    if (prior !== undefined && prior !== identity) throw new Error("Mitigation evaluation excludes conflicting run corrections");
    runtime.set(observation.run.runId, identity);
  }
  const expected = assessMitigation({
    application, control: control as RunObservation[], treatment: treatment as RunObservation[],
    metric: evaluation.metric, alpha: evaluation.alpha, evaluatedAt: evaluation.evaluatedAt,
    appliedAt: stateEvent.observedAt, limitations: evaluation.limitations,
  });
  // Earlier evaluations retain their original disclosure text; recomputation must not rewrite their identity.
  if (mitigationEvaluationIdentity({ ...expected, limitations: evaluation.limitations }) !== evaluation.id) {
    throw new Error("Mitigation evaluation statistics do not match referenced run evidence");
  }
}

function uniqueRuns(
  observations: readonly RunObservation[],
  side: "control" | "treatment",
  application: MitigationApplication,
): RunObservation[] {
  const runs = new Set<number>();
  const facts = new Map<number, string>();
  for (const observation of observations) {
    validateRunObservation(observation);
    if (observation.repository.host !== application.target.host ||
        observation.repository.repositoryId !== application.target.repositoryId) {
      throw new Error("Mitigation assessment evidence crosses repository scope");
    }
    if (runs.has(observation.run.runId)) throw new Error(`Mitigation ${side} samples must use distinct logical runs`);
    runs.add(observation.run.runId);
    if (observation.run.runAttempt !== 1) throw new Error("Mitigation assessment excludes workflow retries");
    if (comparisonProblem(observation.run)) throw new Error("Mitigation assessment includes an ineligible workflow run");
    const priorFacts = facts.get(observation.run.runId);
    const currentFacts = runtimeFactsIdentity(observation.run);
    if (priorFacts !== undefined && priorFacts !== currentFacts) throw new Error("Mitigation assessment includes conflicting run corrections");
    facts.set(observation.run.runId, currentFacts);
  }
  return [...observations].sort((a, b) => Date.parse(a.run.completedAt) - Date.parse(b.run.completedAt) || a.id.localeCompare(b.id));
}
