import { field, items, stringValue } from "../../parsers/yaml.js";
import { defineRule } from "../helpers.js";

function range(text: string): [number, number] | undefined {
  if (text === "*") return [0, 59];
  const match = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  return start <= end && end <= 59 ? [start, end] : undefined;
}

/** The set of minutes past the hour a cron minute field matches, or undefined when it cannot be parsed. */
export function cronMinutes(minuteField: string): Set<number> | undefined {
  const minutes = new Set<number>();
  for (const part of minuteField.split(",")) {
    const [base = "", stepText, extra] = part.split("/");
    if (extra !== undefined) return undefined;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let bounds = range(base);
    // `a/n` means "from a through the end of the range, every n".
    if (bounds && stepText !== undefined && /^\d+$/.test(base)) bounds = [bounds[0], 59];
    if (!bounds) return undefined;
    for (let minute = bounds[0]; minute <= bounds[1]; minute += step) minutes.add(minute);
  }
  return minutes;
}

export default defineRule({
  meta: {
    id: "triggers/frequent-schedule",
    ruleset: "triggers",
    description: "Avoid scheduled workflows that run more often than every 15 minutes.",
    rationale:
      "A cron schedule runs whether or not anything changed, so a workflow that fires every few minutes spends runner time around the clock and competes with pull request checks for the same concurrency pool. GitHub also delays or drops scheduled runs during periods of high load, so very tight schedules rarely deliver the freshness they promise. Event triggers such as `push`, `workflow_dispatch`, or `repository_dispatch` react to real changes; when polling is unavoidable, a 15-minute or longer interval is usually enough.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { maxRunsPerHour: 4 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || value < 1)
        .map(([key]) => `${key} must be a number of at least 1`),
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule",
    ],
    impact: "medium",
    example: {
      bad: "on:\n  schedule:\n    - cron: '*/5 * * * *'",
      good: "on:\n  schedule:\n    - cron: '*/30 * * * *'\n  workflow_dispatch:",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const source = workflow.source;
      const on = field(source, source.doc.contents, "on");
      const schedule = field(source, on?.value, "schedule");
      for (const entry of items(source, schedule?.value)) {
        const cron = field(source, entry, "cron");
        const expression = stringValue(cron?.value)?.trim();
        if (!cron || !expression || expression.includes("${{")) continue;
        const parts = expression.split(/\s+/);
        if (parts.length !== 5) continue;
        const [minuteField = "", hourField = ""] = parts;
        const minutes = cronMinutes(minuteField);
        if (!minutes || minutes.size <= options.maxRunsPerHour) continue;
        const scope = hourField === "*" ? "every hour" : "during its scheduled hours";
        report({
          path: workflow.path,
          line: cron.line,
          key: `on.schedule.${expression}`,
          message: `Schedule "${expression}" runs ${minutes.size} times an hour ${scope}, more than the limit of ${options.maxRunsPerHour}.`,
          suggestion:
            "Trigger the workflow from the event it is waiting for (`push`, `workflow_dispatch`, `repository_dispatch`) or widen the cron interval to every 15 minutes or more.",
          confidence: "high",
        });
      }
    }
  },
});
