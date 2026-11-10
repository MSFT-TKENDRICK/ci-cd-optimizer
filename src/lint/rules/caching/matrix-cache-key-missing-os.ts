import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { matrixCombinations } from "../../parsers/matrix.js";
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

/** Contexts whose value can differ between matrix legs (or between steps), after string literals are removed. */
const LEG_DEPENDENT =
  /\b(?:matrix|runner|env|steps|needs|strategy|job|jobs)\b|\bgithub\.(?:workspace|action_path|action|path|env|output|step_summary)\b/;

/**
 * Conventional download-cache paths are excluded from this native-output detector. This is a conservative
 * reporting choice, not a guarantee that every file stored there is portable across operating systems.
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
  const combos = matrixCombinations(job.matrix) ?? [];
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

interface Target {
  /** Step whose key is analyzed; no automatic key rewrite is safe across all callers. */
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
    description: "Native-output cache keys should distinguish matrix platforms when modeled cache versions can overlap.",
    rationale:
      "Cache matching depends on key, version and accessible branch scope. Versions include configured paths and compression details; Windows has additional cross-OS handling. Under the modeled hosted-runner/action behavior, equal visible inputs can permit incompatible native outputs to share a key. Custom compression, action versions or external configuration can change the version. Concurrent cold runs may all miss before a later run restores the winning cache. Changing keys must preserve every paired restore/save expression and caller, so no automatic rewrite is offered.",
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
    fixable: false,
    example: {
      bad: "runs-on: ${{ matrix.os }}\nstrategy:\n  matrix:\n    os: [ubuntu-latest, macos-latest]\nsteps:\n  - uses: actions/cache@v6\n    with:\n      path: node_modules\n      key: modules-${{ hashFiles('package-lock.json') }}",
      good: "runs-on: ${{ matrix.os }}\nstrategy:\n  matrix:\n    os: [ubuntu-latest, macos-latest]\nsteps:\n  - uses: actions/cache@v6\n    with:\n      path: node_modules\n      key: ${{ runner.os }}-modules-${{ hashFiles('package-lock.json') }}",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
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
          const restoreKeys = rawText(keyStep, "restore-keys");
          const restoreLines = restoreKeys === undefined ? [] : listOf(restoreKeys);
          const suggestion = [
            `Consider adding ${contexts} consistently to every paired save/restore key${restoreLines.length > 0 ? " and restore prefix" : ""}. Review expressions and all callers before changing the cache namespace:`,
            "",
            `key: ${prefix}${keyText}`,
            ...(restoreLines.length > 0 ? ["restore-keys: |", ...restoreLines.map((line) => `  ${prefix}${line}`)] : []),
          ].join("\n");
          const [first, second] = pair as [Leg, Leg];
          report({
            path: workflow.path,
            line: key.line,
            key: `${keyStep.key}.with.key:${needOs ? "os" : ""}${needArch ? "arch" : ""}`,
            message: `Cache key \`${keyText}\` in matrix job \`${job.id}\` has matching modeled key/version inputs on ${describe(first)} and ${describe(second)}. If the actual versions and branch scopes also match, a later restore can receive another platform's native files. Verify archive compatibility rather than assuming a guaranteed collision.`,
            suggestion,
            confidence: "medium",
          });
        }
      }
    }
  },
});
