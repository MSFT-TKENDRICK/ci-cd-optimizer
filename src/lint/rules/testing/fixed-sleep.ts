import { defineRule, jobCommands, stepLine } from "../helpers.js";

/** Commands that start something in the background, which a later fixed wait is presumably waiting for. */
const BACKGROUND =
  /(?:^|[^&])&\s*(?:$|[;#)])|\bnohup\b|\bdocker\s+(?:container\s+)?run\b[^\n]*\s(?:-d|--detach|-\w*d\w*)\b|\bdocker[\s-]compose\s+(?:[^\n]*\s)?up\b[^\n]*\s(?:-d|--detach)\b|\bStart-Process\b|\bstart\s+\/b\b|\bsystemctl\s+start\b|\bservice\s+\S+\s+start\b/i;

const LOOP = /(?:^|[\s;&|(])(?:for|while|until|foreach|do)\b|\bForEach-Object\b|%\s*\{/i;
const UNIT: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600 };

function seconds(value: string | undefined, scale = 1): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/i.exec(value ?? "");
  if (!match) return undefined;
  return (Number(match[1]) * (UNIT[(match[2] ?? "").toLowerCase()] ?? 1)) / scale;
}

/** A fixed wait in seconds and how it was written, when the command is one. */
function fixedWait(command: string): { seconds: number; text: string } | undefined {
  const words = command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ""));
  const tool = (words[0] ?? "").toLowerCase();
  if (tool === "sleep" && words.length === 2) {
    const value = seconds(words[1]);
    return value === undefined ? undefined : { seconds: value, text: `sleep ${words[1]}` };
  }
  if (tool === "start-sleep") {
    let value: number | undefined;
    for (let i = 1; i < words.length; i++) {
      const word = (words[i] ?? "").toLowerCase();
      if (/^-s(?:e(?:c(?:o(?:n(?:d(?:s)?)?)?)?)?)?$/.test(word)) value = seconds(words[i + 1]);
      else if (/^-m(?:i(?:l(?:l(?:i(?:s(?:e(?:c(?:o(?:n(?:d(?:s)?)?)?)?)?)?)?)?)?)?)?$/.test(word)) value = seconds(words[i + 1], 1000);
      else if (i === 1 && /^\d/.test(word)) value = seconds(word);
      else continue;
      break;
    }
    return value === undefined ? undefined : { seconds: value, text: words.join(" ") };
  }
  if (tool === "timeout" || tool === "timeout.exe") {
    const index = words.findIndex((word) => word.toLowerCase() === "/t");
    const value = index > 0 ? seconds(words[index + 1]) : undefined;
    return value === undefined ? undefined : { seconds: value, text: words.join(" ") };
  }
  return undefined;
}

export default defineRule({
  meta: {
    id: "testing/fixed-sleep",
    ruleset: "testing",
    description: "Run steps should wait for services to become ready instead of sleeping for a fixed time.",
    rationale:
      "A fixed `sleep` before tests is a guess: on a fast runner it wastes the whole interval on every run, and on a slow or busy runner it is too short and the tests fail intermittently. Polling for readiness returns as soon as the service is up and fails clearly when it never comes up.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { minSeconds: 5 },
    validateOptions: (options) =>
      typeof options.minSeconds === "number" && options.minSeconds > 0 ? [] : ["minSeconds must be a positive number"],
    references: [
      "https://docs.github.com/en/actions/use-cases-and-examples/using-containerized-services/about-service-containers",
      "https://docs.docker.com/reference/cli/docker/compose/up/",
      "https://www.npmjs.com/package/wait-on",
    ],
    impact: "medium",
    example: {
      bad: "- run: docker compose up -d && sleep 30\n- run: npm run test:e2e",
      good: "- run: docker compose up -d --wait\n- run: npm run test:e2e",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const commands = jobCommands(project, workflow, job);
        let started = job.services.length > 0;
        for (const entry of commands) {
          // `server & sleep 10` backgrounds the first command and waits in the second.
          const parts = entry.command.split(/(?<![&>|])&(?![&>])/).map((part) => part.trim());
          const last = parts.pop() ?? "";
          if (parts.some((part) => part !== "")) started = true;
          const wait = fixedWait(last);
          if (!wait) {
            if (BACKGROUND.test(last)) started = true;
            continue;
          }
          // Without a service started earlier in the job the sleep is likely rate limiting or propagation delay, not readiness.
          if (!started || wait.seconds < options.minSeconds) continue;
          if (LOOP.test(entry.step.run?.value ?? "")) continue;
          report({
            path: workflow.path,
            line: entry.direct ? entry.line : stepLine(entry.owner),
            key: `${entry.step.key}:${entry.command}`,
            message: `\`${wait.text}\` waits a fixed ${wait.seconds} seconds instead of checking that what it waits for is ready.`,
            suggestion:
              "Poll for readiness instead: `docker compose up --wait`, service-container health checks (`--health-cmd`), `npx wait-on <url>`, or a bounded `until curl -fsS <url>; do sleep 1; done` loop.",
          });
        }
      }
    }
  },
});
