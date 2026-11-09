import type { Node } from "yaml";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, items, toJS, type Field, type YamlSource } from "../../parsers/yaml.js";
import type { ProjectModel } from "../../project.js";
import { basename, commandWords } from "../caching/shared.js";

/** Removes package-runner prefixes such as `npx`, `pnpm exec`, `yarn dlx`, `npm exec --` or `python -m`. */
function stripRunner(words: string[]): string[] {
  let rest = words;
  for (let guard = 0; guard < 3; guard += 1) {
    const [first = "", second] = rest;
    if (first === "npx" || first === "bunx" || first === "pnpx") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
    } else if ((first === "pnpm" || first === "yarn" || first === "bun") && (second === "exec" || second === "dlx" || second === "x")) {
      rest = rest.slice(2);
    } else if (first === "npm" && (second === "exec" || second === "x")) {
      rest = rest.slice(2);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
    } else if (/^python[\d.]*$/.test(first) && second === "-m") {
      rest = rest.slice(2);
    } else {
      break;
    }
  }
  return rest;
}

/** Shell words without quotes, env/sudo wrappers or package runners; a path to the tool is reduced to its name. */
export function toolWords(command: string): string[] {
  const words = stripRunner(commandWords(command.replace(/["']/g, "")));
  const [first, ...rest] = words;
  return first === undefined ? [] : [basename(first), ...rest];
}

/** The words of `command` from the tool name on, when it runs one of `names` directly or as `yarn <tool>`/`pnpm <tool>`. */
export function toolInvocation(command: string, names: ReadonlySet<string>): string[] | undefined {
  const words = toolWords(command);
  const [first = "", second = ""] = words;
  if (names.has(first)) return words;
  if ((first === "yarn" || first === "pnpm" || first === "bun") && names.has(second)) return words.slice(1);
  return undefined;
}

const TEST_RUNNERS = new Set(["jest", "vitest", "pytest", "py.test", "mocha", "ava", "karma", "tox", "nox", "phpunit", "rspec"]);
const TEST_SCRIPT = /^(?:test|tests|e2e|unit|integration)(?:[:-][\w:.-]+)?$/i;

/** Names the test command run by `command`, if any (direct runners, build-tool test goals, or a `test` package script). */
export function testCommand(command: string): string | undefined {
  const words = toolWords(command);
  const [first = "", second = "", ...rest] = words;
  const args = [second, ...rest].filter(Boolean);
  if (args.some((word) => word === "--version" || word === "--help" || word === "-h")) return undefined;
  if (TEST_RUNNERS.has(first)) {
    if (first === "vitest" && ["bench", "init", "list"].includes(second)) return undefined;
    if (first === "karma" && second !== "start" && second !== "run") return undefined;
    return first;
  }
  if (first === "playwright" && second === "test") return "playwright test";
  if (first === "cypress" && second === "run") return "cypress run";
  if (first === "go" && second === "test") return "go test";
  if (first === "cargo" && (second === "test" || second === "nextest")) return `cargo ${second}`;
  if (first === "dotnet" && second === "test") return "dotnet test";
  if (["mvn", "mvnw", "mvnw.cmd"].includes(first) && args.some((word) => word === "test" || word === "verify")) return "mvn test";
  if (["gradle", "gradlew", "gradlew.bat"].includes(first) && args.some((word) => /^(?::[\w-]+)*:?(?:test|check|\w+Test)$/.test(word))) {
    return "gradle test";
  }
  if (["npm", "yarn", "pnpm", "bun"].includes(first)) {
    const positional = args.filter((word) => !word.startsWith("-"));
    const run = positional[0] === "run" || positional[0] === "run-script";
    const script = run ? positional[1] : positional[0];
    if (script !== undefined && (TEST_SCRIPT.test(script) || (script === "t" && first === "npm"))) {
      return `${first} ${run ? "run " : ""}${script}`;
    }
  }
  return undefined;
}

/** True when another step reads this step's outcome (the deliberate "continue, then decide" pattern). */
export function outcomeInspected(steps: StepModel[], step: StepModel): boolean {
  if (step.id === undefined) return false;
  const id = step.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`steps\\.${id}\\.(?:outcome|conclusion)|steps\\[['"]${id}['"]\\]\\.(?:outcome|conclusion)`);
  return steps.some((other) => {
    if (other === step) return false;
    const texts = [other.if, other.run?.value, JSON.stringify(other.env), JSON.stringify([...other.with.values()].map((entry) => entry.value))];
    return texts.some((text) => text !== undefined && pattern.test(text));
  });
}

/** The YAML node of a step (`jobs.<id>.steps[i]` or `runs.steps[i]`) in the file that declares it. */
export function stepNode(source: YamlSource, step: StepModel): Node | undefined {
  const match = /^(?:jobs\.(.+)\.steps|runs\.steps)\[(\d+)\]$/.exec(step.key);
  if (!match) return undefined;
  const root = source.doc.contents;
  const parent =
    match[1] !== undefined ? field(source, field(source, root, "jobs")?.value, match[1])?.value : field(source, root, "runs")?.value;
  return items(source, field(source, parent, "steps")?.value)[Number(match[2])];
}

export function jobNode(source: YamlSource, job: JobModel): Node | null | undefined {
  return field(source, field(source, source.doc.contents, "jobs")?.value, job.id)?.value;
}

/** A `continue-on-error` field whose value is literally true (expressions such as `${{ matrix.experimental }}` are deliberate). */
export function continueOnErrorTrue(source: YamlSource, node: Node | null | undefined): Field | undefined {
  const entry = field(source, node, "continue-on-error");
  const value = entry ? toJS(source, entry.value) : undefined;
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true") ? entry : undefined;
}

/** The parsed workflow or action file at `path`. */
export function sourceFor(project: ProjectModel, path: string): WorkflowModel | undefined {
  return project.workflows.find((workflow) => workflow.path === path) ?? project.actions.find((action) => action.path === path);
}

/** Working directory of a step relative to the repository root, or undefined when it is dynamic. */
export function workingDirectory(workflow: WorkflowModel, job: JobModel, step: StepModel): string | undefined {
  const dir = step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory ?? "";
  if (dir.includes("$") || dir.startsWith("/") || dir.startsWith("~")) return undefined;
  return dir.replace(/^\.(?:\/|$)/, "").replace(/\/+$/, "");
}

/** The named script of the package.json in `dir`, when that manifest was loaded. */
export function packageScript(project: ProjectModel, dir: string, name: string): string | undefined {
  const scripts = project.manifests.find((manifest) => manifest.dir === dir)?.json.scripts;
  if (!scripts || typeof scripts !== "object") return undefined;
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** Logical lines of a `run:` script (`\` continuations joined) with each line's offset in the script. */
export function scriptLines(script: string): Array<{ text: string; offset: number }> {
  const result: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  let buffer = "";
  let start = 0;
  for (const raw of script.split("\n")) {
    const lineOffset = offset;
    offset += raw.length + 1;
    const text = raw.replace(/\r$/, "");
    if (buffer === "") start = lineOffset;
    if (/\\\s*$/.test(text)) {
      buffer += text.replace(/\\\s*$/, " ");
      continue;
    }
    buffer += text;
    const trimmed = buffer.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) result.push({ text: buffer, offset: start });
    buffer = "";
  }
  return result;
}
