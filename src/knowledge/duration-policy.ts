export interface DurationObjective {
  /** Exact workflow file; job keys apply to each matrix leg separately. */
  workflow: string;
  job?: string;
  maxDurationMs: number;
}

export interface DurationsConfig {
  minSamples: number;
  objectives: DurationObjective[];
}

export function durationPolicyProblems(config: DurationsConfig): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  if (!Number.isInteger(config.minSamples) || config.minSamples < 2 || config.minSamples > 99) {
    problems.push({ path: "durations.minSamples", message: "Expected an integer between 2 and 99." });
  }
  if (config.objectives.length > 100) problems.push({ path: "durations.objectives", message: "At most 100 duration objectives are supported." });
  const seen = new Set<string>();
  config.objectives.forEach((objective, index) => {
    const path = `durations.objectives[${index}]`;
    if (!/^\.github\/workflows\/[^/\\]+\.ya?ml$/.test(objective.workflow) ||
        [...objective.workflow].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      problems.push({ path: `${path}.workflow`, message: "Expected an exact .github/workflows/*.yml or *.yaml path, not a glob." });
    }
    if (objective.workflow.includes("*") || objective.workflow.includes("?")) {
      problems.push({ path: `${path}.workflow`, message: "Workflow selectors cannot contain globs." });
    }
    if (objective.job !== undefined && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(objective.job)) {
      problems.push({ path: `${path}.job`, message: "Expected a workflow job key." });
    }
    if (!Number.isSafeInteger(objective.maxDurationMs) || objective.maxDurationMs <= 0) {
      problems.push({ path: `${path}.maxDurationMs`, message: "Expected a positive safe integer in milliseconds." });
    }
    const key = JSON.stringify([objective.workflow, objective.job ?? null]);
    if (seen.has(key)) problems.push({ path, message: "Duplicate workflow/job duration objective." });
    seen.add(key);
  });
  return problems;
}
