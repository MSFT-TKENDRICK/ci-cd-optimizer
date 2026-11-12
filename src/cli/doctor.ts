import { parseArgs } from "node:util";
import { diagnoseWorkflow, doctorMarkdown } from "../doctor/doctor.js";
import { githubClient, repoFrom, UsageError, type CliIO } from "./io.js";

export const DOCTOR_HELP = `Usage: ci-cd-optimizer doctor [options]

Observe an exact GitHub workflow failure and attempt a supported local repair by default.
No log commands, repository scripts, issue publication, push or remote rerun are executed.

Options:
      --repo <owner/name>  Repository (default: $GITHUB_REPOSITORY)
      --run-id <id>        Selected run (default: latest completed failure, including startup/timeouts)
      --run-attempt <n>    Exact attempt (requires --run-id; default: observed latest attempt)
      --workflow <name>    Filter latest failure by workflow filename or numeric id
      --report-only        Observe only; never modify the checkout (recommended in workflow_run)
  -f, --format markdown|json  Issue-ready Markdown (default) or structured evidence
  -h, --help               Show help

Repair currently supports unambiguous YAML tab-indentation failures only. It requires a
clean matching GitHub origin, exact failed HEAD and workflow bytes, no symlinks, no newer
rerun, complete evidence, and successful strict/local workflow-parser validation.
It does not run full CI or infer arbitrary fixes. Review the diff and run documented checks.
Exit: 0 repaired locally or no matching failed run; 1 unresolved/collection failure; 2 usage.
`;

export async function doctorCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: {
    repo: { type: "string" }, "run-id": { type: "string" }, "run-attempt": { type: "string" },
    workflow: { type: "string" }, "report-only": { type: "boolean", default: false },
    format: { type: "string", short: "f", default: "markdown" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { io.stdout(DOCTOR_HELP); return 0; }
  if (!["markdown", "json"].includes(values.format)) throw new UsageError("--format must be markdown or json.");
  const number = (value: string | undefined, flag: string) => {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new UsageError(`${flag} must be a positive safe integer.`);
    return Number(value);
  };
  const runId = number(values["run-id"], "--run-id");
  const attempt = number(values["run-attempt"], "--run-attempt");
  if (attempt !== undefined && runId === undefined) throw new UsageError("--run-attempt requires --run-id.");
  if (values.workflow && runId !== undefined) throw new UsageError("--workflow filters latest failure selection; do not combine it with --run-id.");
  if (values.workflow !== undefined && !/^(?:[1-9]\d*|[A-Za-z0-9_.-]+\.ya?ml)$/.test(values.workflow)) {
    throw new UsageError("--workflow must be a workflow filename or positive numeric id.");
  }
  const apiHost = io.env.GITHUB_API_URL ? new URL(io.env.GITHUB_API_URL).hostname : "api.github.com";
  const report = await diagnoseWorkflow(githubClient(io), repoFrom(values.repo, io), {
    cwd: io.cwd, observe: values["report-only"], apiHost: apiHost === "api.github.com" ? "github.com" : apiHost,
    ...(runId === undefined ? {} : { runId }), ...(attempt === undefined ? {} : { attempt }),
    ...(values.workflow ? { workflow: values.workflow } : {}),
  });
  io.stdout(values.format === "json" ? JSON.stringify(report, null, 2) : doctorMarkdown(report));
  return ["repaired-locally", "no-failed-run"].includes(report.status) ? 0 : 1;
}
