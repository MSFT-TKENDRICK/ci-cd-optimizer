import { exprEnd, matchingClose } from "../../parsers/nix.js";
import type { NixFile } from "../../parsers/nix.js";
import type { ProjectModel } from "../../project.js";
import { defineRule } from "../helpers.js";
import { attrsetOf, bindingNamed, callArgument, enclosingOpen, inheritStatements, lintableNixFiles, previousWord, skipLetIn, skipSpace, validateStringLists } from "./expr.js";

const BUILDERS = new Set([
  "mkDerivation",
  "buildGoModule",
  "buildGoPackage",
  "buildGoApplication",
  "buildRustPackage",
  "buildNpmPackage",
  "buildPythonPackage",
  "buildPythonApplication",
  "buildDotnetModule",
  "mkYarnPackage",
  "buildMavenPackage",
  "buildNimPackage",
  "buildDunePackage",
  "buildBazelPackage",
]);
// crane's `craneLib.buildPackage` and naersk's `naersk.buildPackage`; a bare `buildPackage` is too generic.
const QUALIFIED_BUILDERS = new Set(["buildPackage"]);
const DIR_LITERAL = /^\.{1,2}(?:\/\.{1,2})+$/;

interface Finding {
  offset: number;
  builder: string;
  shown: string;
  literal: string;
  where: string;
  confidence: "high" | "medium";
}

/** Repository-relative directory a `./.`-style literal in `file` points to, or undefined when it leaves the repository. */
function resolveDir(file: NixFile, literal: string): string | undefined {
  const parts = file.dir ? file.dir.split("/") : [];
  for (const segment of literal.split("/")) {
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    }
  }
  return parts.join("/");
}

/** Why the directory is "the whole repository": the repository root, or a flake root. */
function describeDir(project: ProjectModel, dir: string): string | undefined {
  if (dir === "") return "the repository root";
  const flake = `${dir}/flake.nix`;
  if (project.files.has(flake) || project.nix.files.some((file) => file.path === flake)) return `\`${dir}/\`, the flake root`;
  return undefined;
}

function candidates(builder: string): string[] {
  if (/Rust|^buildPackage$/.test(builder)) return ["Cargo.toml", "Cargo.lock", "src"];
  if (/Go/.test(builder)) return ["go.mod", "go.sum", "cmd", "internal"];
  if (/Npm|Yarn/.test(builder)) return ["package.json", builder === "mkYarnPackage" ? "yarn.lock" : "package-lock.json", "src"];
  if (/Python/.test(builder)) return ["pyproject.toml", "src"];
  if (/Maven/.test(builder)) return ["pom.xml", "src"];
  if (/Dotnet/.test(builder)) return ["src", "Directory.Build.props"];
  return ["src", "Makefile"];
}

function suggestion(finding: Finding): string {
  const base = finding.literal.replace(/(?:\/\.)+$/, "");
  const files = candidates(finding.builder).map((name) => `${base}/${name}`);
  return [
    "After auditing every build input (including generated files, build scripts, patches and fixtures), consider a fileset. These paths are illustrative, not a complete replacement for your build inputs:",
    "",
    `src = lib.fileset.toSource {`,
    `  root = ${finding.literal};`,
    `  fileset = lib.fileset.unions [ ${files.join(" ")} ]; # every path the build reads`,
    "};",
    "",
    `On older nixpkgs, filter with \`lib.cleanSourceWith { src = ${finding.literal}; filter = path: type: ...; }\`, \`lib.sourceByRegex ${finding.literal} [ ... ]\` or \`builtins.path { path = ${finding.literal}; filter = ...; }\`. \`lib.cleanSource ${finding.literal}\` only drops version-control directories, backup files and some generated files, so it still rebuilds on documentation or CI changes.`,
  ].join("\n");
}

function builderCalls(file: NixFile): { builder: string; open: number }[] {
  const calls: { builder: string; open: number }[] = [];
  for (const ident of file.idents) {
    const last = ident.segments.at(-1) ?? "";
    if (!BUILDERS.has(last) && !(QUALIFIED_BUILDERS.has(last) && ident.segments.length >= 2)) continue;
    const arg = callArgument(file, ident);
    const open = arg ? attrsetOf(file, arg) : undefined;
    if (open !== undefined) calls.push({ builder: last, open });
  }
  return calls;
}

/** Where a binding at `index` is visible: the body of its `let ... in`, or its `rec { }` attribute set. */
function bindingScope(masked: string, index: number): { start: number; end: number } | undefined {
  const container = enclosingOpen(masked, index);
  const containerEnd = container < 0 ? masked.length : matchingClose(masked, container);
  const end = containerEnd < 0 ? masked.length : containerEnd;
  if (container >= 0 && masked[container] === "{" && previousWord(masked, container) === "rec") return { start: container, end };
  const lets = [...masked.slice(0, index).matchAll(/(?<![A-Za-z0-9_'.-])let(?![A-Za-z0-9_'-])/g)].reverse();
  for (const keyword of lets) {
    if (enclosingOpen(masked, keyword.index) !== container) continue;
    const body = skipLetIn(masked, keyword.index);
    if (body > index) return { start: body, end: exprEnd(masked, body) };
  }
  return undefined;
}

/** `src = ./.`-style `let` or `rec` bindings in scope at the builder call `open`, which `inherit src;` there refers to. */
function sourceLiterals(file: NixFile, open: number): string[] {
  const found: string[] = [];
  for (const match of file.masked.matchAll(/(?<![A-Za-z0-9_'.-])src\s*=\s*(\.{1,2}(?:\/\.{1,2})+)\s*;/g)) {
    const scope = bindingScope(file.masked, match.index);
    if (scope && scope.start < open && open < scope.end) found.push(match[1] ?? "");
  }
  return found;
}

function findings(project: ProjectModel, file: NixFile): Finding[] {
  const found: Finding[] = [];
  const calls = builderCalls(file);
  const isFlake = file.path === "flake.nix" || file.path.endsWith("/flake.nix");
  for (const { builder, open } of calls) {
    const binding = bindingNamed(file, open, "src");
    if (binding) {
      const value = file.masked.slice(binding.valueStart, binding.valueEnd).trim();
      if (DIR_LITERAL.test(value)) {
        const dir = resolveDir(file, value);
        const where = dir === undefined ? undefined : describeDir(project, dir);
        if (where !== undefined) {
          found.push({ offset: binding.keyStart, builder, shown: `src = ${value}`, literal: value, where, confidence: "high" });
        }
      } else if (value === "self" && isFlake) {
        const where = describeDir(project, file.dir);
        if (where !== undefined) {
          found.push({ offset: binding.keyStart, builder, shown: "src = self", literal: "./.", where, confidence: "medium" });
        }
      }
      continue;
    }
    const inherited = inheritStatements(file).find(
      (statement) => statement.source === undefined && enclosingOpen(file.masked, statement.offset) === open && statement.names.some((entry) => entry.name === "src"),
    );
    if (!inherited) continue;
    const literals = [...new Set(sourceLiterals(file, open))];
    const literal = literals.length === 1 ? literals[0] : undefined;
    if (literal === undefined) continue;
    const dir = resolveDir(file, literal);
    const where = dir === undefined ? undefined : describeDir(project, dir);
    if (where === undefined) continue;
    const entry = inherited.names.find((name) => name.name === "src");
    found.push({ offset: entry?.offset ?? skipSpace(file.masked, inherited.offset), builder, shown: `inherit src (src = ${literal})`, literal, where, confidence: "medium" });
  }
  return found.sort((a, b) => a.offset - b.offset);
}

export default defineRule({
  meta: {
    id: "nix/src-whole-repo",
    ruleset: "nix",
    description: "Derivations should not use the whole repository (`src = ./.`) as their source.",
    rationale:
      "A broad source path can include files unrelated to the build. Changes to included files affect the source store path and can invalidate derivation reuse, although another cache may already contain the new result. Git-flake filtering and builder-specific filtering affect the actual file set. Selecting all necessary inputs with a fileset can reduce invalidation; omitting a required build script, fixture or generated input changes behavior. Measure and test rather than applying a guessed file list automatically.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { allow: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "allow"),
    references: [
      "https://nix.dev/tutorials/working-with-local-files",
      "https://nixos.org/manual/nixpkgs/stable/#function-library-lib.fileset.toSource",
      "https://nixos.org/manual/nixpkgs/stable/#function-library-lib.fileset.unions",
      "https://nixos.org/manual/nixpkgs/stable/#function-library-lib.sources.cleanSourceWith",
    ],
    impact: "high",
    example: {
      bad: "rustPlatform.buildRustPackage {\n  pname = \"app\";\n  version = \"0.1.0\";\n  src = ./.;\n  cargoLock.lockFile = ./Cargo.lock;\n}",
      good: "rustPlatform.buildRustPackage {\n  pname = \"app\";\n  version = \"0.1.0\";\n  src = lib.fileset.toSource {\n    root = ./.;\n    fileset = lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./src ];\n  };\n  cargoLock.lockFile = ./Cargo.lock;\n}",
    },
  },
  check({ project, options, report }) {
    const allowed = new Set(options.allow);
    for (const file of lintableNixFiles(project)) {
      if (allowed.has(file.path)) continue;
      const seen = new Map<string, number>();
      for (const finding of findings(project, file)) {
        const count = (seen.get(finding.builder) ?? 0) + 1;
        seen.set(finding.builder, count);
        report({
          path: file.path,
          line: file.lineOf(finding.offset),
          message: `\`${finding.shown}\` in \`${finding.builder}\` selects ${finding.where} as source. Changes to included but unused files (possibly docs, CI workflows or flake.lock) can change the source hash and reduce cache reuse. Actual filtering and required inputs need review.`,
          suggestion: suggestion(finding),
          confidence: finding.confidence,
          key: `src:${finding.builder}#${count}`,
        });
      }
    }
  },
});
