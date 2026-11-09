import { isAlias, isMap, isPair, isScalar, isSeq, Scalar } from "yaml";
import { fix } from "../../fix.js";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { SourceFile, TextEdit } from "../../types.js";
import { defineRule } from "../helpers.js";
import { isTrue, listOf, usesAction } from "./shared.js";

type Combo = Record<string, unknown>;

interface Leg {
  label: string;
  os: "Linux" | "macOS" | "Windows";
  /** Undefined when the label does not pin an architecture we can verify. */
  arch?: "X64" | "ARM64";
  combo: Combo;
}

/** Abort expansion beyond this many combinations; the rule then stays silent. */
const COMBINATION_CAP = 1000;

/** Contexts whose value can differ between matrix legs (or between steps), after string literals are removed. */
const LEG_DEPENDENT =
  /\b(?:matrix|runner|env|steps|needs|strategy|job|jobs)\b|\bgithub\.(?:workspace|action_path|action|path|env|output|step_summary)\b/;

/**
 * Download caches whose contents are platform-neutral (package tarballs, jars, module sources). Sharing them between
 * operating systems is harmless, so the rule stays silent when a cache holds only these.
 */
const NEUTRAL_PATHS = new Set([
  "~/.npm",
  "~/.cache/yarn",
  "~/.yarn/berry/cache",
  ".yarn/cache",
  "~/.pnpm-store",
  "~/.local/share/pnpm/store",
  "~/.m2",
  "~/.m2/repository",
  "~/.gradle/caches",
  "~/.gradle/wrapper",
  "~/go/pkg/mod",
  "~/.nuget/packages",
  "~/.cargo/registry",
  "~/.cargo/registry/index",
  "~/.cargo/registry/cache",
  "~/.cargo/git",
  "~/.cargo/git/db",
  "~/.cache/pip",
]);

const isPrimitive = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);
const same = (a: unknown, b: unknown): boolean => isPrimitive(a) && isPrimitive(b) && String(a) === String(b);

function records(value: unknown): Combo[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)) ? (value as Combo[]) : undefined;
}

/**
 * GitHub's documented expansion: cross product, then `exclude` (partial match), then each `include` entry is merged
 * into every original combination it does not contradict on an original key, or appended as a new combination.
 */
function combinations(matrix: Record<string, unknown>): Combo[] | undefined {
  if ("__expression" in matrix) return undefined;
  const includes = records(matrix.include);
  const excludes = records(matrix.exclude);
  if (!includes || !excludes) return undefined;
  const dimensions = Object.entries(matrix).filter(([name]) => name !== "include" && name !== "exclude");
  if (dimensions.some(([, values]) => !Array.isArray(values) || values.length === 0)) return undefined;
  const product = dimensions.reduce((total, [, values]) => total * (values as unknown[]).length, 1);
  if (product > COMBINATION_CAP) return undefined;
  if (excludes.some((entry) => Object.values(entry).some((value) => !isPrimitive(value)))) return undefined;
  const original = new Set(dimensions.map(([name]) => name));
  if (includes.some((entry) => Object.entries(entry).some(([key, value]) => original.has(key) && !isPrimitive(value)))) return undefined;
  let combos: Combo[] = dimensions.length > 0 ? [{}] : [];
  for (const [name, values] of dimensions) {
    combos = combos.flatMap((combo) => (values as unknown[]).map((value) => ({ ...combo, [name]: value })));
  }
  combos = combos.filter((combo) => !excludes.some((entry) => Object.entries(entry).every(([key, value]) => same(combo[key], value))));
  const base = combos.length;
  const added: Combo[] = [];
  for (const entry of includes) {
    let matched = false;
    for (let index = 0; index < base; index += 1) {
      const combo = combos[index] ?? {};
      if (Object.entries(entry).every(([key, value]) => !original.has(key) || same(combo[key], value))) {
        combos[index] = { ...combo, ...entry };
        matched = true;
      }
    }
    if (!matched) added.push({ ...entry });
  }
  const all = [...combos, ...added];
  return all.length <= COMBINATION_CAP ? all : undefined;
}

/** `matrix.a.b` → the value in the combination; missing properties evaluate to an empty string. */
function matrixValue(combo: Combo, path: string): string | undefined {
  let value: unknown = combo;
  for (const segment of path.split(".")) {
    value = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Combo)[segment] : undefined;
  }
  if (value === undefined || value === null) return "";
  return isPrimitive(value) ? String(value) : undefined;
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const MATRIX_PATH = /^matrix((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)$/;

/** Substitutes every `${{ … }}` with `term`; undefined as soon as one expression cannot be resolved. */
function substitute(text: string, term: (expression: string) => string | undefined): string | undefined {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(EXPRESSION)) {
    const value = term((match[1] ?? "").trim());
    if (value === undefined) return undefined;
    out += text.slice(last, match.index) + value;
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

/** Hosted-runner labels from the GitHub-hosted runners reference; anything else (self-hosted, custom) is ignored. */
function platformOf(label: string): Pick<Leg, "os" | "arch"> | undefined {
  const name = label.trim().toLowerCase();
  if (/^ubuntu-(?:latest|slim|\d\d\.\d\d)$/.test(name)) return { os: "Linux", arch: "X64" };
  if (/^ubuntu-\d\d\.\d\d-arm$/.test(name)) return { os: "Linux", arch: "ARM64" };
  if (/^macos-\d+-intel$/.test(name)) return { os: "macOS", arch: "X64" };
  if (/^(?:macos-(?:latest|1[4-9]|[2-9]\d)|xcode-\d+)$/.test(name)) return { os: "macOS", arch: "ARM64" };
  if (/^macos-(?:latest|\d+)-x?large$|^macos-13$/.test(name)) return { os: "macOS" };
  if (/^windows-(?:latest|20\d\d(?:-vs\d{4})?)$/.test(name)) return { os: "Windows", arch: "X64" };
  if (/^windows-11(?:-vs\d{4})?-arm$/.test(name)) return { os: "Windows", arch: "ARM64" };
  return undefined;
}

function legsOf(job: JobModel): Leg[] {
  const runsOn = job.runsOn?.value;
  if (!job.matrix || typeof runsOn !== "string" || !/\$\{\{[^}]*\bmatrix\./.test(runsOn)) return [];
  const combos = combinations(job.matrix) ?? [];
  const legs: Leg[] = [];
  for (const combo of combos) {
    const label = substitute(runsOn, (expression) => {
      const path = MATRIX_PATH.exec(expression)?.[1];
      return path === undefined ? undefined : matrixValue(combo, path.slice(1));
    });
    const platform = label === undefined ? undefined : platformOf(label);
    if (label !== undefined && platform) legs.push({ label: label.trim(), combo, ...platform });
  }
  return legs;
}

/** Resolves `env.NAME` to a leg-independent token when every declaration of NAME is a leg-independent value. */
function envResolver(workflow: WorkflowModel, job: JobModel, step: StepModel): (name: string) => string | undefined {
  const exported = job.steps.some((candidate) => /GITHUB_ENV/.test(candidate.run?.value ?? ""));
  return (name) => {
    if (exported) return undefined;
    const declared = [step.env, job.env, workflow.env].filter((scope) => Object.hasOwn(scope, name)).map((scope) => scope[name]);
    if (declared.length === 0) return undefined;
    const independent = declared.every((value) => isPrimitive(value) && !LEG_DEPENDENT.test(String(value).replace(/'(?:[^']|'')*'/g, "''")));
    return independent ? `env.${name}` : undefined;
  };
}

/** The text a key or path evaluates to on one leg, or undefined when it depends on something we cannot model. */
function evaluate(text: string, leg: Leg, env: (name: string) => string | undefined): string | undefined {
  return substitute(text, (expression) => {
    if (expression === "runner.os") return leg.os;
    if (expression === "runner.arch") return leg.arch ?? `arch(${leg.label})`;
    const path = MATRIX_PATH.exec(expression)?.[1];
    if (path !== undefined) return matrixValue(leg.combo, path.slice(1));
    const variable = /^env\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(expression)?.[1];
    if (variable !== undefined) return env(variable);
    if (LEG_DEPENDENT.test(expression.replace(/'(?:[^']|'')*'/g, "''"))) return undefined;
    // Windows checkouts may convert line endings, so a file hash is not assumed equal to the POSIX legs' hash.
    if (leg.os === "Windows" && /hashFiles/i.test(expression)) return `{${expression}@windows}`;
    return `{${expression}}`;
  });
}

function directChild(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
  return pair && !isAlias(pair.value) ? pair.value : undefined;
}

/** The step's block mapping when the step and the path to it are written inline (no anchors, aliases or merge keys). */
function stepNode(workflow: WorkflowModel, step: StepModel): unknown {
  const match = /^jobs\.([^.]+)\.steps\[(\d+)\]$/.exec(step.key);
  if (!match) return undefined;
  const steps = directChild(directChild(directChild(workflow.source.doc.contents, "jobs"), match[1] ?? ""), "steps");
  if (!isSeq(steps)) return undefined;
  const node = steps.items[Number(match[2])];
  if (!isMap(node) || node.flow || lineOfNode(workflow.source, node) !== step.line) return undefined;
  return node;
}

const INLINE_TYPES: unknown[] = [Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE];

/** Zero-width insertion at the start of a single-line scalar's value. */
function prependScalar(file: SourceFile, node: unknown, prefix: string): TextEdit | undefined {
  if (!isScalar(node) || !node.range || !INLINE_TYPES.includes(node.type)) return undefined;
  const [start, end] = node.range;
  if (file.content.slice(start, end).includes("\n")) return undefined;
  const offset = start + (node.type === Scalar.PLAIN ? 0 : 1);
  return { path: file.path, start: offset, end: offset, text: prefix };
}

/** Prefixes every restore key, which must each be a prefix of the primary key (so they keep matching after the fix). */
function prependRestoreKeys(file: SourceFile, node: unknown, key: string, prefix: string): Array<TextEdit | undefined> {
  if (node === undefined) return [];
  if (!isScalar(node) || typeof node.value !== "string" || !node.range) return [undefined];
  const keys = listOf(node.value);
  if (keys.length === 0 || keys.some((entry) => !key.startsWith(entry))) return [undefined];
  if (node.type !== Scalar.BLOCK_LITERAL) return [prependScalar(file, node, prefix)];
  const [start, end] = node.range;
  const edits: Array<TextEdit | undefined> = [];
  let position = file.content.indexOf("\n", start) + 1;
  while (position > 0 && position < end) {
    const next = file.content.indexOf("\n", position);
    const line = file.content.slice(position, next < 0 ? file.content.length : next).replace(/\r$/, "");
    const content = line.trimStart();
    if (content.startsWith("#")) return [undefined];
    if (content !== "") {
      const offset = position + line.length - content.length;
      edits.push({ path: file.path, start: offset, end: offset, text: prefix });
    }
    if (next < 0) break;
    position = next + 1;
  }
  return edits.length > 0 ? edits : [undefined];
}

function prefixEdits(file: SourceFile, workflow: WorkflowModel, step: StepModel, prefix: string): Array<TextEdit | undefined> {
  const withNode = directChild(stepNode(workflow, step), "with");
  if (!isMap(withNode) || withNode.flow) return [undefined];
  const keyNode = directChild(withNode, "key");
  const keyText = isScalar(keyNode) && typeof keyNode.value === "string" ? keyNode.value : undefined;
  if (keyText === undefined) return [undefined];
  return [prependScalar(file, keyNode, prefix), ...prependRestoreKeys(file, directChild(withNode, "restore-keys"), keyText, prefix)];
}

interface Target {
  /** Step whose `key` (and `restore-keys`) is analyzed and fixed. */
  keyStep: StepModel;
  /** Step that saves the cache; its `path` is part of the cache version. */
  saveStep: StepModel;
}

function targetOf(job: JobModel, step: StepModel): Target | undefined {
  if (usesAction(step, "actions/cache")) return { keyStep: step, saveStep: step };
  if (!usesAction(step, "actions/cache/save")) return undefined;
  const key = step.with.get("key")?.value;
  const reference = typeof key === "string" ? /^\$\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.cache-primary-key\s*\}\}$/.exec(key.trim()) : null;
  if (!reference) return { keyStep: step, saveStep: step };
  const restore = job.steps.find((candidate) => candidate.id === reference[1] && candidate.index < step.index);
  return restore && usesAction(restore, "actions/cache/restore") ? { keyStep: restore, saveStep: step } : undefined;
}

function rawText(step: StepModel, input: string): string | undefined {
  const value = step.with.get(input)?.value;
  return typeof value === "string" ? value : undefined;
}

function describe(leg: Leg): string {
  return `\`${leg.label}\` (${leg.os}${leg.arch ? ` ${leg.arch}` : ""})`;
}

export default defineRule({
  meta: {
    id: "caching/matrix-cache-key-missing-os",
    ruleset: "caching",
    description: "`actions/cache` keys in a matrix that spans operating systems or CPU architectures must include `runner.os`/`runner.arch`.",
    rationale:
      "A cache entry is identified by its key plus a version that only hashes `path`, the compression method (zstd on every GitHub-hosted image) and, on Windows without `enableCrossOsArchive`, a Windows marker. When a matrix runs the same job on Linux and macOS (or on x64 and arm64) and the key does not include `runner.os`/`runner.arch`, every leg computes the same key and version. Caches are immutable, so the first leg to save wins: the other legs get an exact hit, restore that platform's files with `cache-hit: true`, and never save their own. Native modules in `node_modules`, virtualenvs and build output are then restored for the wrong OS or CPU.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/cache#cache-version",
      "https://github.com/actions/cache/blob/main/tips-and-workarounds.md#cross-os-cache",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#runner-context",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching",
    ],
    impact: "high",
    fixable: true,
    example: {
      bad: "runs-on: ${{ matrix.os }}\nstrategy:\n  matrix:\n    os: [ubuntu-latest, macos-latest]\nsteps:\n  - uses: actions/cache@v6\n    with:\n      path: node_modules\n      key: modules-${{ hashFiles('package-lock.json') }}",
      good: "runs-on: ${{ matrix.os }}\nstrategy:\n  matrix:\n    os: [ubuntu-latest, macos-latest]\nsteps:\n  - uses: actions/cache@v6\n    with:\n      path: node_modules\n      key: ${{ runner.os }}-modules-${{ hashFiles('package-lock.json') }}",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        if (job.containerImage) continue;
        const legs = legsOf(job);
        if (new Set(legs.map((leg) => `${leg.os}/${leg.arch ?? leg.label}`)).size < 2) continue;
        const reported = new Set<number>();
        for (const step of job.steps) {
          const target = targetOf(job, step);
          if (!target) continue;
          const { keyStep, saveStep } = target;
          const key = keyStep.with.get("key");
          const path = rawText(saveStep, "path");
          if (!key || key.kind === "literal" || typeof key.value !== "string" || path === undefined) continue;
          if (reported.has(key.line)) continue;
          if ([keyStep, saveStep].some((candidate) => /\b(?:matrix|runner)\./.test(candidate.if ?? ""))) continue;
          const crossOsInputs = [...new Set([keyStep, saveStep])].map((candidate) => candidate.with.get("enableCrossOsArchive"));
          if (crossOsInputs.some((input) => input !== undefined && input.kind !== "literal")) continue;
          const crossOs = crossOsInputs.every((input) => isTrue(input?.value));
          const entries = listOf(path).filter((entry) => !entry.startsWith("!"));
          if (entries.length > 0 && entries.every((entry) => NEUTRAL_PATHS.has(entry.replace(/\/+$/, "")))) continue;
          const keyEnv = envResolver(workflow, job, keyStep);
          const pathEnv = envResolver(workflow, job, saveStep);
          const signatures = legs.map((leg) => {
            const keyValue = evaluate(key.value as string, leg, keyEnv);
            const pathValue = evaluate(path, leg, pathEnv);
            return keyValue === undefined || pathValue === undefined
              ? undefined
              : `${leg.os === "Windows" && !crossOs ? "windows" : "posix"}\u0000${keyValue}\u0000${pathValue}`;
          });
          if (signatures.some((signature) => signature === undefined)) continue;
          let needOs = false;
          let needArch = false;
          let pair: [Leg, Leg] | undefined;
          legs.forEach((a, i) => {
            legs.slice(i + 1).forEach((b, offset) => {
              if (signatures[i] !== signatures[i + 1 + offset]) return;
              const osClash = a.os !== b.os;
              const archClash = !osClash && a.arch !== undefined && b.arch !== undefined && a.arch !== b.arch;
              if (!osClash && !archClash) return;
              needOs ||= osClash;
              needArch ||= archClash;
              pair ??= [a, b];
            });
          });
          if (!pair) continue;
          reported.add(key.line);
          const prefix = `${needOs ? "${{ runner.os }}-" : ""}${needArch ? "${{ runner.arch }}-" : ""}`;
          const contexts = [needOs ? "`runner.os`" : "", needArch ? "`runner.arch`" : ""].filter(Boolean).join(" and ");
          const keyText = key.value;
          const twins = job.steps.filter(
            (candidate) => candidate !== keyStep && usesAction(candidate, "actions/cache/restore") && rawText(candidate, "key") === keyText,
          );
          const repair = file
            ? fix(
                `Prefix the cache key${keyStep.with.has("restore-keys") || twins.length > 0 ? " and restore keys" : ""} with ${prefix.replace(/-$/, "")}`,
                ...[keyStep, ...twins].flatMap((candidate) => prefixEdits(file, workflow, candidate, prefix)),
              )
            : undefined;
          const restoreKeys = rawText(keyStep, "restore-keys");
          const restoreLines = restoreKeys === undefined ? [] : listOf(restoreKeys);
          const suggestion = [
            `Add ${contexts} to the key${restoreLines.length > 0 ? " and every restore key" : ""} so each platform saves and restores its own cache:`,
            "",
            `key: ${prefix}${keyText}`,
            ...(restoreLines.length > 0 ? ["restore-keys: |", ...restoreLines.map((line) => `  ${prefix}${line}`)] : []),
          ].join("\n");
          const [first, second] = pair as [Leg, Leg];
          report({
            path: workflow.path,
            line: key.line,
            key: `${keyStep.key}.with.key:${needOs ? "os" : ""}${needArch ? "arch" : ""}`,
            message: `Cache key \`${keyText}\` in matrix job \`${job.id}\` resolves to the same key and cache version on ${describe(first)} and ${describe(second)}. Caches are immutable, so whichever leg saves first wins: the other leg gets an exact hit (\`cache-hit: true\`), restores the first platform's files and never saves its own — useless at best, wrong-platform native binaries at worst.`,
            suggestion,
            ...(repair ? { fix: repair } : {}),
          });
        }
      }
    }
  },
});
