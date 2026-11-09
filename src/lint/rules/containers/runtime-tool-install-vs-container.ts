import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule, jobRunsOnLabels } from "../helpers.js";
import { systemInstall } from "./docker.js";

type Ecosystem = "apt" | "npm" | "pip" | "pipx" | "cargo" | "go" | "binary";

interface ToolInstall {
  ecosystem: Ecosystem;
  /** Normalized identity of what is installed; equal keys install the same tools. */
  key: string;
  /** Packages, crates, modules or the download URL, for messages and suggestions. */
  items: string[];
}

interface Occurrence {
  install: ToolInstall;
  command: string;
  path: string;
  line: number;
  job: string;
}

const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"]);
const PIP_VALUE_FLAGS = new Set([
  "-i",
  "--index-url",
  "--extra-index-url",
  "-t",
  "--target",
  "--prefix",
  "-f",
  "--find-links",
  "--root",
  "--python-version",
  "--platform",
  "--implementation",
  "--abi",
  "--trusted-host",
  "--cache-dir",
  "--src",
  "--upgrade-strategy",
  "--progress-bar",
  "--log",
  "--proxy",
  "--retries",
  "--timeout",
  "--python",
  "-p",
]);
/** Installs of a project's own dependencies (or a local path), not of a standalone tool. */
const PIP_PROJECT_FLAGS = new Set(["-r", "--requirement", "-e", "--editable", "-c", "--constraint", "--group"]);
const NPM_VALUE_FLAGS = new Set(["--prefix", "--registry", "--location", "--cache", "--userconfig", "-C", "--dir"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "corepack", "pip", "setuptools", "wheel", "uv", "pipx"]);

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, "$2");
}

function toolName(word: string | undefined): string {
  const base = (word ?? "").split("/").pop() ?? "";
  return base.replace(/\.exe$/i, "");
}

/** Command words with env assignments, `sudo` and its flags removed and quotes stripped. */
function words(command: string): string[] {
  const result = commandWords(command).map(unquote);
  while (result[0]?.startsWith("-")) {
    const flag = result.shift() ?? "";
    if (SUDO_VALUE_FLAGS.has(flag)) result.shift();
  }
  return result;
}

/** Name of an npm package spec without its version: `@scope/name@1` -> `@scope/name`. */
function npmName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

function pipName(spec: string): string {
  return spec.split(/[[<>=!~;\s]/)[0] ?? spec;
}

function positionals(args: string[], valueFlags: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function install(ecosystem: Ecosystem, items: string[]): ToolInstall | undefined {
  if (items.length === 0 || items.some((item) => item.includes("$") || item === "")) return undefined;
  const sorted = [...new Set(items)].sort();
  return { ecosystem, key: `${ecosystem}:${sorted.join(" ")}`, items: sorted };
}

function aptInstall(input: string[]): ToolInstall | undefined {
  const found = systemInstall(input);
  if (found?.installer !== "apt") return undefined;
  return install(
    "apt",
    found.packages.map(unquote).filter((name) => !name.includes("::")),
  );
}

function npmGlobalInstall([head, verb, ...rest]: string[]): ToolInstall | undefined {
  const name = toolName(head);
  let args: string[];
  if (name === "yarn") {
    if (verb !== "global" || rest[0] !== "add") return undefined;
    args = rest.slice(1);
  } else if (name === "npm" || name === "pnpm") {
    if (!["install", "i", "add"].includes(verb ?? "")) return undefined;
    const global = rest.some((arg, index) => arg === "-g" || arg === "--global" || arg === "--location=global" || (arg === "--location" && rest[index + 1] === "global"));
    if (!global) return undefined;
    args = rest;
  } else {
    return undefined;
  }
  const packages = positionals(args, NPM_VALUE_FLAGS).filter((spec) => !/^[./~]/.test(spec) && !spec.includes(":"));
  if (packages.length === 0 || packages.some((spec) => PACKAGE_MANAGERS.has(npmName(spec)))) return undefined;
  return install("npm", packages);
}

function pipInstall(input: string[]): ToolInstall | undefined {
  let rest: string[];
  const name = toolName(input[0]);
  if (/^pip(\d+(\.\d+)?)?$/.test(name)) rest = input.slice(1);
  else if (/^python(\d+(\.\d+)?)?$/.test(name) && input[1] === "-m" && /^pip\d*$/.test(input[2] ?? "")) rest = input.slice(3);
  else if (name === "uv" && input[1] === "pip") rest = input.slice(2);
  else return undefined;
  if (rest[0] !== "install") return undefined;
  const args = rest.slice(1);
  if (args.some((arg) => PIP_PROJECT_FLAGS.has(arg) || [...PIP_PROJECT_FLAGS].some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)))) {
    return undefined;
  }
  const packages = positionals(args, PIP_VALUE_FLAGS).map((spec) => spec.toLowerCase());
  if (packages.some((spec) => /^[./~]/.test(spec) || spec.includes("/") || /\.(whl|tar\.gz|zip)$/.test(spec))) return undefined;
  const tools = packages.filter((spec) => !PACKAGE_MANAGERS.has(pipName(spec)));
  return tools.length === packages.length ? install("pip", tools) : undefined;
}

function pipxInstall([head, verb, sub, ...rest]: string[]): ToolInstall | undefined {
  const name = toolName(head);
  let args: string[] | undefined;
  if (name === "pipx" && verb === "install") args = [sub ?? "", ...rest];
  else if (name === "uv" && verb === "tool" && sub === "install") args = rest;
  if (!args) return undefined;
  const packages = positionals(args, new Set(["--python", "--with", "--index-url", "--pip-args", "-p"])).map((spec) => spec.toLowerCase());
  return packages.some((spec) => /^[./~]/.test(spec) || spec.includes("/")) ? undefined : install("pipx", packages);
}

function cargoInstall([head, verb, ...rest]: string[]): ToolInstall | undefined {
  if (toolName(head) !== "cargo" || verb !== "install") return undefined;
  if (rest.some((arg) => arg === "--path" || arg.startsWith("--path="))) return undefined;
  const items = rest.filter((arg) => arg !== "--locked" && arg !== "--force" && arg !== "-f" && arg !== "--quiet" && arg !== "-q");
  return items.length > 0 ? { ecosystem: "cargo", key: `cargo:${items.join(" ")}`, items } : undefined;
}

function goInstall([head, verb, ...rest]: string[]): ToolInstall | undefined {
  if (toolName(head) !== "go" || verb !== "install") return undefined;
  const modules = positionals(rest, new Set(["-modfile", "-tags", "-ldflags", "-gcflags"]));
  return modules.length === 0 || modules.some((module) => module.startsWith(".") || !module.includes("@")) ? undefined : install("go", modules);
}

/** `curl -fsSL https://.../tool.tar.gz | tar -xz -C /usr/local/bin`: an unpacked binary download. */
function binaryDownload(command: string): ToolInstall | undefined {
  const stages = command.split(/\|&?/);
  if (stages.length < 2) return undefined;
  const first = words(stages[0] ?? "");
  if (!["curl", "wget"].includes(toolName(first[0]))) return undefined;
  if (!stages.slice(1).some((stage) => toolName(words(stage)[0]) === "tar")) return undefined;
  const url = /https?:\/\/[^\s'"|]+/.exec(stages[0] ?? "")?.[0];
  return url ? install("binary", [url]) : undefined;
}

function toolInstall(command: string): ToolInstall | undefined {
  const binary = binaryDownload(command);
  if (binary) return binary;
  if (/\|/.test(command)) return undefined;
  const parsed = words(command);
  return aptInstall(parsed) ?? npmGlobalInstall(parsed) ?? pipInstall(parsed) ?? pipxInstall(parsed) ?? cargoInstall(parsed) ?? goInstall(parsed);
}

function posixShell(workflow: WorkflowModel, job: JobModel, step: StepModel): boolean {
  const shell = step.shell ?? job.shell ?? workflow.shell;
  return !shell || /^(bash|sh)\b/i.test(shell.trim());
}

/** A GitHub-hosted Ubuntu job that runs directly on the VM (job containers require Linux runners). */
function eligible(job: JobModel): boolean {
  if (job.uses || job.containerImage) return false;
  const labels = jobRunsOnLabels(job);
  if (labels.length === 0 || labels.some((label) => label.includes("${{"))) return false;
  if (!labels.some((label) => /^ubuntu-/i.test(label))) return false;
  // Jobs that drive the Docker daemon (image builds, compose) would need Docker-in-Docker inside a job container.
  return !job.steps.some(
    (step) =>
      step.uses?.action.name?.startsWith("docker/") === true ||
      commandsOf(step).some(({ command }) => /^(docker|docker-compose|podman|buildah)$/.test(toolName(words(command)[0]))),
  );
}

function dockerfile(install: ToolInstall): string {
  const items = install.items.join(" ");
  switch (install.ecosystem) {
    case "apt":
      return `FROM ubuntu:24.04\nRUN apt-get update \\\n && apt-get install -y --no-install-recommends ${items} \\\n && rm -rf /var/lib/apt/lists/*`;
    case "npm":
      return `FROM node:22-bookworm-slim\nRUN npm install -g ${items}`;
    case "pip":
      return `FROM python:3.12-slim\nRUN pip install --no-cache-dir ${items}`;
    case "pipx":
      return `FROM python:3.12-slim\nENV PIPX_BIN_DIR=/usr/local/bin\nRUN pip install --no-cache-dir pipx && pipx install ${items}`;
    case "cargo":
      return `FROM rust:1-slim\nRUN cargo install ${items}`;
    case "go":
      return `FROM golang:1-bookworm\nRUN go install ${items}`;
    case "binary":
      return `FROM ubuntu:24.04\nADD --checksum=sha256:<sha256> ${items} /tmp/tool.tar.gz\nRUN tar -xzf /tmp/tool.tar.gz -C /usr/local/bin && rm /tmp/tool.tar.gz`;
  }
}

function describeInstall(install: ToolInstall): string {
  return install.ecosystem === "binary" ? `the archive \`${install.items[0]}\`` : install.items.map((item) => `\`${item}\``).join(", ");
}

export default defineRule({
  meta: {
    id: "containers/runtime-tool-install-vs-container",
    ruleset: "containers",
    description: "The same tools are installed at runtime in several jobs instead of being baked into a job container image.",
    rationale:
      "Every job starts on a fresh runner VM, so a tool installed with apt, npm -g, pip, cargo, go install or a curl | tar download is downloaded and installed again in every job and every run, before the job does any useful work, and its version floats with whatever the package index serves that day. Baking the tools into an image once and running the jobs in it with `jobs.<id>.container` replaces each install with an image pull and pins the toolset to an immutable image.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: { minJobs: 2 },
    validateOptions: (options) =>
      options.minJobs !== undefined && !(Number.isInteger(options.minJobs) && (options.minJobs as number) >= 2)
        ? ["minJobs must be an integer of at least 2"]
        : [],
    references: [
      "https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/run-jobs-in-a-container",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontainer",
    ],
    impact: "low",
    fixable: false,
    example: {
      bad: "lint:\n  runs-on: ubuntu-latest\n  steps:\n    - run: sudo apt-get install -y shellcheck jq\ntest:\n  runs-on: ubuntu-latest\n  steps:\n    - run: sudo apt-get install -y jq shellcheck",
      good: "lint:\n  runs-on: ubuntu-latest\n  container: ghcr.io/acme/app/ci-tools:2026-01-15\n  steps:\n    - run: shellcheck scripts/*.sh",
    },
  },
  check({ project, options, report }) {
    const minJobs = options.minJobs;
    const groups = new Map<string, Occurrence[]>();
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        if (!eligible(job)) continue;
        for (const step of job.steps) {
          if (!step.run || !posixShell(workflow, job, step)) continue;
          for (const { command, line } of commandsOf(step)) {
            const found = toolInstall(command);
            if (!found) continue;
            const list = groups.get(found.key) ?? [];
            list.push({ install: found, command, path: workflow.path, line, job: job.id });
            groups.set(found.key, list);
          }
        }
      }
    }
    for (const [key, occurrences] of groups) {
      const perJob = new Map<string, Occurrence>();
      for (const occurrence of [...occurrences].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) {
        const id = `${occurrence.path}#${occurrence.job}`;
        if (!perJob.has(id)) perJob.set(id, occurrence);
      }
      if (perJob.size < minJobs) continue;
      const [first, ...others] = [...perJob.values()];
      if (!first) continue;
      const where = [first, ...others]
        .slice(0, 5)
        .map((occurrence) => `\`${occurrence.job}\` (${occurrence.path}:${occurrence.line})`)
        .join(", ");
      const more = perJob.size > 5 ? ` and ${perJob.size - 5} more` : "";
      report({
        path: first.path,
        line: first.line,
        key: `runtime-tool:${key}`,
        message: `\`${first.command.trim()}\` installs ${describeInstall(first.install)} at runtime in ${perJob.size} jobs: ${where}${more}. Each job re-downloads and installs the same tools on a fresh runner in every run before doing any work.`,
        suggestion: `Bake the tools into a CI image, publish it to GHCR from a workflow that runs when that Dockerfile changes, and run these jobs in it:\n# ci/tools.Dockerfile\n${dockerfile(first.install)}\n\n# each job\nruns-on: ubuntu-latest\ncontainer:\n  image: ghcr.io/<owner>/<repo>/ci-tools:<tag>\n  credentials: # only for a private image; the job needs \`permissions: packages: read\`\n    username: \${{ github.actor }}\n    password: \${{ secrets.GITHUB_TOKEN }}\nJob containers need a Linux runner; steps then run inside the container, and service containers are reached by their service name instead of localhost.`,
        related: others.map((occurrence) => ({ path: occurrence.path, line: occurrence.line })),
        impact: "low",
        confidence: "medium",
      });
    }
  },
});
