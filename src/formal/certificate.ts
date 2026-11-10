import { parseHillClimbConfig } from "../experiments/config.js";
import { decide } from "../experiments/decide.js";
import { armBranch, parseManifest, trunkBranch } from "../experiments/manifest.js";
import { parseMeasurements } from "../experiments/measurements.js";
import { evaluateArm, metricsFor, selectionParameters } from "../experiments/score.js";
import { analyzeCacheKey, CACHE_ASSUMPTIONS, extractCacheKey } from "./cache-key.js";
import { PROOF_BUILD } from "./generated/manifest.js";
import { canonicalJson, certificateDigest, integer, object, parseStrictJson, scalarString, string, type Json } from "./json.js";
import { evaluateCandidate, OBJECTIVE_SCALE, WEIGHT_SCALE } from "./selection.js";
import { bindSources, decodeSourceBlob, validateSourceBlob, type SourceBlob } from "./source.js";

export const CERTIFICATE_SCHEMA = "cicd-optimizer/certificate-v1";

function seal<T extends object>(body: T) { return { ...body, digest: certificateDigest(body) }; }

export function createCacheCertificate(source: SourceBlob, job: string, step: number, dependencies: string[] | null) {
  validateSourceBlob(source);
  scalarString(job);
  if (!job || job.length > 512) throw new Error("Invalid job selector.");
  const extraction = extractCacheKey(source, job, step);
  return seal({
    schema: CERTIFICATE_SCHEMA, kind: "cache-key", proof: PROOF_BUILD,
    source, request: { job, step, dependencies },
    assumptions: CACHE_ASSUMPTIONS,
    extraction,
    result: analyzeCacheKey(extraction.key, dependencies),
  });
}

const SELECTION_ASSUMPTIONS = [
  "The universe is exactly the manifest's unique ASCII-named arms, ordered by ASCII name. Missing measurements are pending; unlisted measurements are excluded.",
  "The objective is a quantized weighted score, not elapsed time itself, a global search optimum, or proof that a recommendation addresses a real bottleneck.",
  "Committed observations (including checks, changed paths and judge scores) are inputs, not authenticated evidence. Arm code can fabricate measurements; Git blob binding does not attest execution.",
  "CI inputs require distinct successful first-attempt workflow_dispatch observations matching recorded heads, expected branches and workflow identity, with durations recomputed from timestamps. This offline certificate does not contact GitHub; consistent provenance is not authenticated execution or equivalent workload.",
  "Metric extraction, medians, observed-tail Mann-Whitney filtering, dependency parsing, clock/expiry interpretation and decimal quantization are tested trusted preprocessing, not proved by the integer selector.",
  "CI noise filtering is an unadjusted repeated-comparison heuristic, not a significance guarantee; regression gates apply to scored deltas after that filter.",
  "At expiry the reducer may promote the best currently eligible candidate despite unfinished nonfailed candidates. Their unknown outcomes and all unproposed candidates remain outside the maximum claim.",
] as const;

export interface DecisionSources { manifest: SourceBlob; config: SourceBlob; measurements: SourceBlob }

export function createDecisionCertificate(sources: DecisionSources, at: string) {
  const sourceList = Object.values(sources);
  sourceList.forEach(validateSourceBlob);
  if (new Set(sourceList.map((source) => source.commit)).size !== 1) throw new Error("Decision inputs must be recorded at the same commit.");
  const now = new Date(at);
  if (!Number.isFinite(now.getTime()) || now.toISOString() !== at) throw new Error("Decision time must be a canonical UTC ISO timestamp with milliseconds.");
  const parsedConfig = parseHillClimbConfig(sources.config.content);
  if (parsedConfig.problems.length) throw new Error(`Invalid committed scoring configuration: ${JSON.stringify(parsedConfig.problems)}`);
  const config = parsedConfig.config;
  const parsedManifest = parseManifest(sources.manifest.content, { config });
  if (!parsedManifest.manifest) throw new Error(`Invalid committed manifest: ${JSON.stringify(parsedManifest.problems)}`);
  const manifest = parsedManifest.manifest;
  const measurements = parseMeasurements(sources.measurements.content);
  const decision = decide(manifest, measurements, config, { now, trunkRef: trunkBranch(manifest.name), armRef: (arm) => armBranch(manifest.name, arm) });
  const parameters = selectionParameters(config);
  const candidates = [...manifest.arms].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((arm) => {
    const measured = measurements.arms.find((entry) => entry.arm === arm.name);
    const { candidate } = evaluateArm(manifest, measurements.control, measured ?? { arm: arm.name, changedPaths: [] }, config);
    return { name: arm.name, inputs: candidate, outcome: evaluateCandidate(candidate, parameters.minimum, parameters.influence) };
  });
  return seal({
    schema: CERTIFICATE_SCHEMA, kind: "finite-selection", proof: PROOF_BUILD,
    sources, request: { at }, assumptions: SELECTION_ASSUMPTIONS,
    result: {
      objective: { scale: OBJECTIVE_SCALE, weightScale: WEIGHT_SCALE, ...parameters, metrics: metricsFor(manifest, config).map((metric) => metric.id), tieBreak: "rank-desc,deterministic-desc,ascii-name-asc" },
      candidateUniverse: candidates.map((candidate) => candidate.name),
      unlistedMeasurements: measurements.arms.filter((arm) => !manifest.arms.some((spec) => spec.name === arm.arm)).map((arm) => arm.arm).sort(),
      allNonfailedCandidatesFinished: candidates.every((candidate) => candidate.outcome.failed || !candidate.outcome.pending),
      candidates,
      exclusions: candidates.filter((candidate) => !candidate.outcome.eligible).map((candidate) => ({
        name: candidate.name, reason: candidate.outcome.failed ? "hard-gate-failed" : candidate.outcome.pending ? "unfinished" : "below-minimum",
      })),
      decision: {
        action: decision.action, reason: decision.reason,
        ...(decision.action === "promote" ? { winner: decision.winner, losers: decision.losers } : {}),
        ...(decision.action === "wait" ? { dispatch: decision.dispatch } : {}),
      },
    },
  });
}

function decodeDependencies(value: Json | undefined): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error("Declared dependencies must be an array or null (explicit inference policy).");
  return value.map((entry) => string(entry, "dependency"));
}

/** All assertions, hashes, extraction bytes, witnesses and outcomes are recomputed, not trusted from the certificate. */
export async function checkCertificate(text: string, repository?: string): Promise<{ status: "source-bound-valid" | "model-valid"; kind: string; digest: string }> {
  const supplied = object(parseStrictJson(text), "certificate");
  if (supplied.schema !== CERTIFICATE_SCHEMA || canonicalJson(supplied.proof) !== canonicalJson(PROOF_BUILD)) throw new Error("Certificate schema or compiled-in proof build does not match this checker.");
  const request = object(supplied.request, "request");
  let expected: ReturnType<typeof createCacheCertificate> | ReturnType<typeof createDecisionCertificate>;
  let sources: SourceBlob[];
  if (supplied.kind === "cache-key") {
    const source = decodeSourceBlob(supplied.source);
    sources = [source];
    expected = createCacheCertificate(source, string(request.job, "job"), integer(request.step, "step"), decodeDependencies(request.dependencies));
  } else if (supplied.kind === "finite-selection") {
    const input = object(supplied.sources, "sources");
    const decoded = { manifest: decodeSourceBlob(input.manifest), config: decodeSourceBlob(input.config), measurements: decodeSourceBlob(input.measurements) };
    sources = Object.values(decoded);
    expected = createDecisionCertificate(decoded, string(request.at, "at"));
  } else throw new Error("Unsupported certificate kind.");
  if (canonicalJson(supplied) !== canonicalJson(expected)) throw new Error("Certificate does not match full recomputation (including its digest).");
  if (repository !== undefined) await bindSources(sources, repository);
  return { status: repository === undefined ? "model-valid" : "source-bound-valid", kind: expected.kind, digest: expected.digest };
}
