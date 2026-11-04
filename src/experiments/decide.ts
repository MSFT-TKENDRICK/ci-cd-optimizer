import type { HillClimbConfig } from "./config.js";
import type { ExperimentManifest } from "./manifest.js";
import { metricsFor, scoreArm, type ArmScore, type ExperimentMeasurements } from "./score.js";

export interface DispatchRequest {
  /** Branch to run the workflow on (an arm branch or the trunk control). */
  ref: string;
  arm: string;
  workflow: string;
  runs: number;
}

export type Decision =
  | { action: "skip"; reason: string; scores: ArmScore[] }
  | { action: "wait"; reason: string; scores: ArmScore[]; dispatch: DispatchRequest[] }
  | { action: "promote"; winner: string; losers: string[]; reason: string; scores: ArmScore[] }
  | { action: "reject"; reason: string; scores: ArmScore[] }
  | { action: "expire"; reason: string; scores: ArmScore[] };

const DAY = 86_400_000;

export function isExpired(manifest: ExperimentManifest, config: HillClimbConfig, now: Date): boolean {
  const expires = Date.parse(manifest.expiresAt);
  const maxAge = Date.parse(manifest.createdAt) + config.selection.maxAgeDays * DAY;
  return now.getTime() >= Math.min(Number.isNaN(expires) ? Infinity : expires, Number.isNaN(maxAge) ? Infinity : maxAge);
}

/** Highest rank wins; ties fall back to the deterministic score, then the arm name for reproducibility. */
function best(scores: ArmScore[]): ArmScore | undefined {
  return scores
    .filter((score) => score.qualifies)
    .sort((a, b) => b.rank - a.rank || b.deterministic - a.deterministic || a.arm.localeCompare(b.arm))[0];
}

/**
 * Deterministic grading. The LLM judge only reorders arms that already beat the control on measurements and pass
 * every gate, so a persuasive but unmeasured arm can never be promoted.
 */
export function decide(
  manifest: ExperimentManifest,
  measurements: ExperimentMeasurements,
  config: HillClimbConfig,
  options: { now?: Date; trunkRef: string; armRef: (arm: string) => string },
): Decision {
  const now = options.now ?? new Date();
  const scores = manifest.arms.map((spec) => {
    const measured = measurements.arms.find((arm) => arm.arm === spec.name);
    if (!measured) {
      return { arm: spec.name, metrics: [], deterministic: 0, rank: 0, pending: ["arm has not been built yet"], failures: [], qualifies: false } satisfies ArmScore;
    }
    return scoreArm(manifest, measurements.control, measured, config);
  });
  if (manifest.status !== "running") return { action: "skip", reason: `experiment is ${manifest.status}`, scores };

  const expired = isExpired(manifest, config, now);
  const winner = best(scores);
  const pending = scores.filter((score) => score.pending.length > 0 && score.failures.length === 0);
  const losers = (name: string) => manifest.arms.map((arm) => arm.name).filter((arm) => arm !== name);

  // Promote early only when no unfinished arm could still overtake the leader.
  if (winner && (pending.length === 0 || expired)) {
    return { action: "promote", winner: winner.arm, losers: losers(winner.arm), reason: `${winner.arm} improved the weighted metrics by ${(winner.deterministic * 100).toFixed(1)}%`, scores };
  }
  if (expired) return { action: "expire", reason: `no arm qualified within ${config.selection.maxAgeDays} days`, scores };
  if (pending.length === 0) {
    const leader = [...scores].sort((a, b) => b.deterministic - a.deterministic)[0];
    const why = leader?.failures.length ? leader.failures.join("; ") : `best improvement ${(Math.max(0, leader?.deterministic ?? 0) * 100).toFixed(1)}% is below the ${(config.selection.minImprovement * 100).toFixed(1)}% bar`;
    return { action: "reject", reason: `no arm qualified (${why})`, scores };
  }

  const dispatch: DispatchRequest[] = [];
  const ciSpecs = metricsFor(manifest, config).filter((spec) => spec.source === "ci" && spec.workflow);
  for (const spec of ciSpecs) {
    let control = 0;
    for (const score of pending) {
      const needs = score.metrics.find((metric) => metric.id === spec.id)?.needs;
      if (!needs) continue;
      control = Math.max(control, needs.control);
      if (needs.arm > 0) dispatch.push({ ref: options.armRef(score.arm), arm: score.arm, workflow: spec.workflow as string, runs: needs.arm });
    }
    if (control > 0) dispatch.push({ ref: options.trunkRef, arm: "trunk", workflow: spec.workflow as string, runs: control });
  }
  const merged = new Map<string, DispatchRequest>();
  for (const request of dispatch) {
    const key = `${request.ref}\u0000${request.workflow}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, runs: Math.max(existing.runs, request.runs) } : request);
  }
  return { action: "wait", reason: `${pending.length} arm(s) still collecting evidence`, scores, dispatch: [...merged.values()] };
}

const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const fmt = (value: number | undefined) => (value === undefined ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

export function renderDecision(manifest: ExperimentManifest, decision: Decision): string {
  const heading = {
    skip: "⏭️ Skipped",
    wait: "⏳ Collecting evidence",
    promote: `🏆 Promoting \`${decision.action === "promote" ? decision.winner : ""}\``,
    reject: "❌ Rejected",
    expire: "⌛ Expired",
  }[decision.action];
  const metricIds = [...new Set(decision.scores.flatMap((score) => score.metrics.map((metric) => metric.id)))];
  const lines = [
    `### ${heading}: ${manifest.title}`,
    "",
    `**Hypothesis:** ${manifest.hypothesis}`,
    "",
    `**Decision:** ${decision.reason}`,
    "",
    `| Arm | ${metricIds.map((id) => `\`${id}\``).join(" | ")} | Score | Rank | Status |`,
    `| --- | ${metricIds.map(() => "---").join(" | ")} | --- | --- | --- |`,
    ...decision.scores.map((score) => {
      const cells = metricIds.map((id) => {
        const metric = score.metrics.find((candidate) => candidate.id === id);
        if (!metric || metric.arm === undefined) return metric?.needs ? `needs ${metric.needs.arm} run(s)` : "–";
        const p = metric.pValue === undefined ? "" : ` (p=${metric.pValue.toFixed(3)})`;
        return `${fmt(metric.control)} → ${fmt(metric.arm)} ${pct(metric.delta)}${p}`;
      });
      const status = score.failures.length ? `❌ ${score.failures.join("; ")}` : score.pending.length ? `⏳ ${score.pending.join("; ")}` : score.qualifies ? "✅ qualifies" : "➖ no measurable gain";
      return `| \`${score.arm}\` | ${cells.join(" | ")} | ${pct(score.deterministic)} | ${score.rank.toFixed(3)} | ${status} |`;
    }),
  ];
  if (decision.action === "wait" && decision.dispatch.length > 0) {
    lines.push("", "Requested additional runs:", ...decision.dispatch.map((request) => `- \`${request.workflow}\` on \`${request.ref}\` × ${request.runs}`));
  }
  lines.push("", "<sub>Scores are relative improvements over the experiment trunk (control). The judge can only reorder arms that already pass every gate.</sub>");
  return lines.join("\n");
}
