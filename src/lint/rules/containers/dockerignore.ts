import { withString } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { commandsOf, defineRule, steps, stepsUsing } from "../helpers.js";
import { contextSources, isBroadCopy } from "./docker.js";

/** Normalizes a repository-relative directory or file path; undefined for dynamic or out-of-repo paths. */
function normalize(path: string, base = ""): string | undefined {
  if (path.includes("$") || path.startsWith("/") || /^[a-z]+:\/\//i.test(path) || path === "-") return undefined;
  const parts = base ? base.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentDirs(dir: string): string[] {
  const parts = dir ? dir.split("/") : [];
  const result: string[] = [];
  for (let length = parts.length - 1; length >= 0; length -= 1) result.push(parts.slice(0, length).join("/"));
  return result;
}

const BUILD_VALUE_FLAGS = new Set([
  "-t", "--tag", "--build-arg", "--target", "--platform", "--cache-from", "--cache-to", "--label", "--secret", "--ssh",
  "-o", "--output", "--network", "--progress", "--builder", "--iidfile", "--metadata-file", "--add-host", "--build-context",
  "--shm-size", "--ulimit", "--annotation", "--attest", "--allow", "--call", "--cgroup-parent", "-m", "--memory", "--isolation",
]);

interface BuildRef {
  dockerfile: string;
  context: string;
}

/** `docker build` / `docker buildx build` / `docker image build` invocations in a shell command. */
function parseDockerBuild(command: string, base: string): BuildRef | undefined {
  const words = command.split(/\s+/).filter(Boolean).map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
  const start = words.findIndex(
    (word, index) =>
      /^(docker|podman)$/.test(word) &&
      (words[index + 1] === "build" || (["buildx", "image"].includes(words[index + 1] ?? "") && words[index + 2] === "build")),
  );
  if (start < 0) return undefined;
  const args = words.slice(start + (words[start + 1] === "build" ? 2 : 3));
  let file: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-f" || arg === "--file") {
      file = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else if (BUILD_VALUE_FLAGS.has(arg)) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  const contextArg = positional[positional.length - 1];
  if (contextArg === undefined) return undefined;
  const context = normalize(contextArg, base);
  if (context === undefined) return undefined;
  const dockerfile = file !== undefined ? normalize(file, base) : join(context, "Dockerfile");
  return dockerfile !== undefined ? { dockerfile, context } : undefined;
}

function workflowBuilds(project: ProjectModel): BuildRef[] {
  const models = [...project.workflows, ...project.actions];
  const refs: BuildRef[] = [];
  for (const { step } of stepsUsing(models, "docker/build-push-action")) {
    const contextInput = withString(step, "context");
    const fileInput = withString(step, "file");
    const contextPath = contextInput === undefined ? "" : contextInput.replace(/^\{\{\s*defaultContext\s*\}\}:?/, "");
    const context = normalize(contextPath);
    if (context === undefined) continue;
    const dockerfile = fileInput !== undefined ? normalize(fileInput) : join(context, "Dockerfile");
    if (dockerfile !== undefined) refs.push({ dockerfile, context });
  }
  for (const { workflow, job, step } of steps(models)) {
    const base = normalize(step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory ?? "");
    if (base === undefined) continue;
    for (const { command } of commandsOf(step)) {
      const ref = parseDockerBuild(command, base);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** Converts a .dockerignore pattern (moby/patternmatcher syntax) to an anchored regular expression. */
function patternRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += (pattern[index] ?? "").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) {
        source += "\\[";
      } else {
        source += pattern.slice(index, close + 1).replace(/^\[!/, "[^");
        index = close;
      }
    } else {
      source += char.replace(/[.+^${}()|\\/]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${source}$`);
  } catch {
    return /^\b$/;
  }
}

/** Docker semantics: patterns apply to the path or any parent directory; the last matching pattern wins. */
function isExcluded(content: string, path: string): boolean {
  const candidates = path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const raw of content.split(/\r?\n/)) {
    let pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    if (negated) pattern = pattern.slice(1).trim();
    pattern = pattern.replace(/^(\.?\/)+/, "").replace(/\/+$/, "");
    if (pattern === "") continue;
    const regex = patternRegex(pattern);
    if (candidates.some((candidate) => regex.test(candidate))) excluded = !negated;
  }
  return excluded;
}

function describeContext(context: string): string {
  return context ? `\`${context}\`` : "the repository root";
}

export default defineRule({
  meta: {
    id: "containers/dockerignore",
    ruleset: "containers",
    description: "Docker build contexts that are copied into images should have a .dockerignore excluding .git and node_modules.",
    rationale:
      "Without a .dockerignore, `COPY . .` sends and hashes the whole context, including `.git`, `node_modules`, and local build output. Every commit, install, or agent scratch file then changes the COPY checksum and invalidates that layer and everything after it, and large contexts slow down every build.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/concepts/context/#dockerignore-files",
      "https://docs.docker.com/build/cache/invalidation/",
    ],
    impact: "medium",
    example: {
      bad: "# no .dockerignore next to the Dockerfile\nFROM node:22-slim\nCOPY . .",
      good: "# .dockerignore\n.git\n**/node_modules\ndist",
    },
  },
  check({ project, report }) {
    const builds = workflowBuilds(project);
    const reportedIgnoreFiles = new Set<string>();
    for (const model of project.dockerfiles) {
      const copies = model.instructions.filter((instruction) => contextSources(instruction) !== undefined);
      if (copies.length === 0) continue;
      const broad = copies.find(isBroadCopy);
      const referenced = [...new Set(builds.filter((build) => build.dockerfile === model.path).map((build) => build.context))];
      let contexts = referenced;
      if (contexts.length === 0) {
        // The build context is unknown; an ancestor .dockerignore suggests builds run from that ancestor.
        if (parentDirs(model.dir).some((dir) => project.files.has(join(dir, ".dockerignore")))) continue;
        contexts = [model.dir];
      }
      for (const context of contexts) {
        const ignorePath = [`${model.path}.dockerignore`, join(context, ".dockerignore")].find((path) => project.files.has(path));
        if (ignorePath === undefined) {
          const copy = broad ?? copies[0];
          if (!copy) continue;
          report({
            path: model.path,
            line: copy.line,
            key: `missing:${context || "."}`,
            message: `Build context ${describeContext(context)} has no .dockerignore, so \`${copy.keyword} ${copy.args.replace(/\s+/g, " ").trim()}\` sends and hashes everything in it, including \`.git\` and \`node_modules\`; unrelated changes bust this layer's cache.`,
            suggestion: `Add \`${join(context, ".dockerignore")}\` (or \`${model.path}.dockerignore\`) excluding at least \`.git\`, \`**/node_modules\`, build output (\`dist\`, \`coverage\`) and \`.env*\`; or use an allowlist: \`*\` followed by \`!src\`, \`!package.json\`, ...`,
            confidence: broad ? "high" : "medium",
          });
          continue;
        }
        if (!broad || reportedIgnoreFiles.has(ignorePath)) continue;
        const content = project.files.get(ignorePath)?.content ?? "";
        const missing: string[] = [];
        if (!isExcluded(content, ".git")) missing.push(".git");
        const packageDirs = project.manifests
          .map((manifest) => manifest.dir)
          .filter((dir) => dir === context || (context === "" ? dir !== "" : dir.startsWith(`${context}/`)))
          .map((dir) => (dir === context ? "" : dir.slice(context ? context.length + 1 : 0)))
          .sort();
        const unexcluded = packageDirs.map((dir) => join(dir, "node_modules")).filter((path) => !isExcluded(content, path));
        if (unexcluded.length > 0) missing.push(...unexcluded.slice(0, 3), ...(unexcluded.length > 3 ? [`${unexcluded.length - 3} more node_modules`] : []));
        if (missing.length === 0) continue;
        reportedIgnoreFiles.add(ignorePath);
        report({
          path: ignorePath,
          line: 1,
          key: "incomplete",
          impact: "low",
          message: `${ignorePath} does not exclude ${missing.map((entry) => `\`${entry}\``).join(", ")}, which \`${broad.keyword} ${broad.args.replace(/\s+/g, " ").trim()}\` in ${model.path} (line ${broad.line}) copies into the image and hashes on every build.`,
          suggestion: `Add ${missing.includes(".git") ? "`.git` and " : ""}\`**/node_modules\` (patterns are anchored at the context root, so plain \`node_modules\` only matches the top level).`,
          related: [{ path: model.path, line: broad.line }],
        });
      }
    }
  },
});
