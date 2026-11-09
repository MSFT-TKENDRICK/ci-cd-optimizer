import { field, toJS } from "../../parsers/yaml.js";
import type { JobModel, ServiceModel, WorkflowModel } from "../../parsers/workflow.js";
import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule } from "../helpers.js";

/** Readiness probes for common service images; anything else gets a placeholder. */
const HEALTH_COMMANDS: Array<[RegExp, string]> = [
  [/(^|\/)(postgres|postgis)(:|@|$)/, "pg_isready"],
  [/(^|\/)(mysql|percona)(:|@|$)/, '"mysqladmin ping"'],
  [/(^|\/)mariadb(:|@|$)/, '"healthcheck.sh --connect --innodb_initialized"'],
  [/(^|\/)(redis|valkey)(:|@|$)/, '"redis-cli ping"'],
  [/(^|\/)mongo(:|@|$)/, "\"mongosh --quiet --eval 'db.runCommand({ ping: 1 })'\""],
  [/(^|\/)rabbitmq(:|@|$)/, '"rabbitmq-diagnostics -q ping"'],
];

/** Commands that start something in the background the job may legitimately be waiting for instead of a service. */
const BACKGROUND = [
  /(?:^|[^&|>])&\s*$/,
  /\b(?:nohup|setsid|disown|daemonize|start-stop-daemon)\b/,
  /\bdocker(?:-compose|\s+compose)?\s+(?:run|up|start|container\s+run)\b[^\n]*(?:\s-[a-zA-Z]*d[a-zA-Z]*\b|\s--detach\b|\s--wait\b)/,
  /\b(?:systemctl|service)\b[^\n]*\bstart\b/,
  /\b(?:pm2|forever)\s+start\b/,
  /\b(?:kubectl|helm|kind|minikube|k3d|terraform|pulumi|az|aws|gcloud)\b/,
];

const LOOP = /(?:^|[\s;&|(])(?:until|while|for)\s/;

function healthCommand(image: string): string {
  const normalized = image.toLowerCase();
  return HEALTH_COMMANDS.find(([pattern]) => pattern.test(normalized))?.[1] ?? '"<command that exits 0 once the service accepts connections>"';
}

/** Literal `options` of a service: the string, `null` when absent, `undefined` when it is computed by an expression. */
function serviceOptions(workflow: WorkflowModel, job: JobModel, service: ServiceModel): string | null | undefined {
  const source = workflow.source;
  const jobs = field(source, source.doc.contents, "jobs")?.value;
  const services = field(source, field(source, jobs, job.id)?.value, "services")?.value;
  const options = field(source, field(source, services, service.name)?.value, "options");
  if (!options) return null;
  const value = toJS(source, options.value);
  const text = Array.isArray(value) ? value.map(String).join(" ") : typeof value === "string" ? value : undefined;
  if (text === undefined || text.includes("${{")) return undefined;
  return text;
}

/** Seconds of a `sleep N` command (`10`, `10s`, `1m`, `0.5h`). */
function sleepSeconds(command: string): number | undefined {
  const words = commandWords(command);
  if (words[0] !== "sleep" || words.length !== 2) return undefined;
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(words[1] ?? "");
  if (!match) return undefined;
  const scale = match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 1;
  return Number(match[1]) * scale;
}

export default defineRule({
  meta: {
    id: "containers/sleep-polling-health-check",
    ruleset: "containers",
    description: "A job with service containers waits for them with a fixed `sleep` instead of a `--health-cmd` health check.",
    rationale:
      "Service containers start before the job's steps, but without a health check nothing tells the runner whether the database or broker inside is ready yet. A fixed `sleep` is a guess: too short and the first connection fails intermittently on a slow start, too long and every run pays the full delay. With `options: --health-cmd ...` the runner waits until the container reports healthy before running the steps, which is both exact and as fast as the service allows.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { minSeconds: 5 },
    validateOptions: (options) =>
      options.minSeconds !== undefined && (typeof options.minSeconds !== "number" || !(options.minSeconds >= 1))
        ? ["minSeconds must be a number of at least 1"]
        : [],
    references: [
      "https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idservicesservice_idoptions",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "services:\n  postgres:\n    image: postgres:16\nsteps:\n  - run: sleep 15\n  - run: npm test",
      good: "services:\n  postgres:\n    image: postgres:16\n    options: >-\n      --health-cmd pg_isready\n      --health-interval 2s\n      --health-timeout 5s\n      --health-retries 30\nsteps:\n  - run: npm test",
    },
  },
  check({ project, options, report }) {
    const minSeconds = options.minSeconds;
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        if (job.uses || job.services.length === 0) continue;
        const unchecked = job.services
          .map((service) => ({ service, options: serviceOptions(workflow, job, service) }))
          .filter(
            (entry): entry is { service: ServiceModel; options: string | null } =>
              entry.options !== undefined && !/(?:^|\s)--health-cmd\b/.test(entry.options ?? "") && !entry.service.image.value.includes("${{"),
          );
        if (unchecked.length === 0) continue;
        let background = false;
        for (const step of job.steps) {
          if (!step.run) continue;
          const shell = step.shell ?? job.shell ?? workflow.shell;
          if (shell && !/^(bash|sh)\b/i.test(shell.trim())) continue;
          const loop = LOOP.test(step.run.value);
          for (const { command, line } of commandsOf(step)) {
            if (BACKGROUND.some((pattern) => pattern.test(command))) background = true;
            const seconds = sleepSeconds(command);
            if (background || loop || seconds === undefined || seconds < minSeconds) continue;
            const names = unchecked.map(({ service }) => `\`${service.name}\` (\`${service.image.value}\`)`).join(", ");
            const snippets = unchecked
              .map(
                ({ service, options: existing }) =>
                  `  ${service.name}:\n    image: ${service.image.value}\n    options: >-\n${existing ? `      ${existing.trim().replace(/\s+/g, " ")}\n` : ""}      --health-cmd ${healthCommand(service.image.value)}\n      --health-interval 2s\n      --health-timeout 5s\n      --health-retries 30`,
              )
              .join("\n");
            report({
              path: workflow.path,
              line,
              key: `${step.key}:sleep-health:${line}`,
              message: `\`${command.trim()}\` waits a fixed ${seconds}s in job \`${job.id}\`, whose service container${unchecked.length > 1 ? "s" : ""} ${names} ${unchecked.length > 1 ? "have" : "has"} no \`--health-cmd\`. The sleep is a guess: too short and the first connection fails intermittently, too long and every run pays the full ${seconds}s. With a health check the runner waits until the service is healthy before running the steps.`,
              suggestion: `Add a health check to the service and delete \`${command.trim()}\`:\nservices:\n${snippets}`,
              impact: "medium",
              confidence: "medium",
            });
          }
        }
      }
    }
  },
});
