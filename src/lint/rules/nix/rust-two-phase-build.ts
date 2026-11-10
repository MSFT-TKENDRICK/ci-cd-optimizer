import type { NixFile, NixIdent } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  attrsetOf,
  bindingNamed,
  callArgument,
  enclosingOpen,
  headIdent,
  inheritStatements,
  isBindingKey,
  isPathLiteral,
  isValueUse,
  lintableNixFiles,
  skipLetIn,
  skipSpace,
  snippet,
  stringAt,
  validateStringLists,
  wordOffsets,
} from "./expr.js";

/** Words showing the file already splits dependency compilation from the crate (crane, naersk) or uses per-crate derivations. */
const TWO_PHASE_MARKERS = ["crane", "craneLib", "naersk", "cargoArtifacts", "buildDepsOnly", "buildRustCrate", "crate2nix"];
/** Source helpers whose result is a filtered copy of a local path. */
const LOCAL_SOURCE_HELPERS = new Set([
  "cleanSource",
  "cleanSourceWith",
  "cleanCargoSource",
  "sourceByRegex",
  "sourceFilesBySuffices",
  "gitignoreSource",
  "gitignoreFilterWith",
  "toSource",
]);

interface LocalSource {
  text: string;
  line: number;
}

function sourceHead(file: NixFile, offset: number): number {
  let cursor = skipLetIn(file.masked, offset);
  while (file.masked[cursor] === "(") cursor = skipLetIn(file.masked, cursor + 1);
  return cursor;
}

/** Whether the expression at `offset` is a local source tree (path literal, `self`, or a filtered local path). */
function isLocalSource(file: NixFile, start: number, end: number): boolean {
  const head = sourceHead(file, start);
  const text = file.masked.slice(head, end).trim();
  if (isPathLiteral(text)) return true;
  const ident: NixIdent | undefined = headIdent(file, head);
  if (!ident) return false;
  const last = ident.segments.at(-1) ?? "";
  if (ident.text === "self" || ident.text === "inputs.self" || ident.text === "self.outPath") return true;
  if (ident.segments.includes("fileset") || LOCAL_SOURCE_HELPERS.has(last) || ident.text === "nix-gitignore.gitignoreSource" || ident.text === "builtins.path") {
    const argument = callArgument(file, ident);
    if (!argument) return false;
    const open = attrsetOf(file, argument);
    if (open !== undefined) {
      const source = bindingNamed(file, open, "src") ?? bindingNamed(file, open, "root") ?? bindingNamed(file, open, "path");
      return source !== undefined && isLocalSource(file, source.valueStart, source.valueEnd);
    }
    return argument.start > ident.offset && isPathLiteral(file.masked.slice(argument.start, argument.end).trim());
  }
  return false;
}

/** The single same-file `src = ...;` binding, used to resolve `inherit src;`. */
function uniqueSrcBinding(file: NixFile): { start: number; end: number } | undefined {
  const found: { start: number; end: number }[] = [];
  for (const offset of wordOffsets(file, "src")) {
    if (file.masked[offset - 1] === "." || !isBindingKey(file.masked, offset, 3)) continue;
    const start = skipSpace(file.masked, skipSpace(file.masked, offset + 3) + 1);
    const semicolon = file.masked.indexOf(";", start);
    if (semicolon < 0) continue;
    found.push({ start, end: semicolon });
  }
  return found.length === 1 ? found[0] : undefined;
}

function localSource(file: NixFile, open: number): LocalSource | undefined {
  const binding = bindingNamed(file, open, "src");
  if (binding) {
    if (!isLocalSource(file, binding.valueStart, binding.valueEnd)) return undefined;
    return { text: snippet(file, binding.valueStart, binding.valueEnd, 50), line: binding.line };
  }
  const inheritsSrc = inheritStatements(file).some(
    (statement) => statement.source === undefined && enclosingOpen(file.masked, statement.offset) === open && statement.names.some(({ name }) => name === "src"),
  );
  if (!inheritsSrc) return undefined;
  const outer = uniqueSrcBinding(file);
  if (!outer || outer.start > open || !isLocalSource(file, outer.start, outer.end)) return undefined;
  return { text: snippet(file, outer.start, outer.end, 50), line: file.lineOf(outer.start) };
}

function packageName(file: NixFile, open: number): string | undefined {
  for (const key of ["pname", "name"]) {
    const binding = bindingNamed(file, open, key);
    if (!binding) continue;
    const string = stringAt(file, binding.valueStart);
    if (string && !string.interpolated) return string.value;
  }
  return undefined;
}

export default defineRule({
  meta: {
    id: "nix/rust-two-phase-build",
    ruleset: "nix",
    description: "Rust crates built from local source should compile dependencies in a separate, cacheable derivation.",
    rationale:
      "Standard buildRustPackage separates dependency source fetching from package compilation, not necessarily dependency compilation from workspace compilation. When included local source changes, the package derivation can change, and a cache miss may rebuild dependency crates. Two-phase builders such as crane can reuse compatible compiled artifacts, but their inputs also include toolchains, features, native dependencies and build scripts, not only Cargo.lock. Custom phases and compiler caches can already provide reuse. Measure representative builds and preserve all build behavior before migrating.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["strict", "insights"],
    requires: [],
    defaultOptions: { allow: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "allow"),
    references: [
      "https://crane.dev/API.html#cranelibbuilddepsonly",
      "https://crane.dev/introduction/artifact-reuse.html",
      "https://nixos.org/manual/nixpkgs/stable/#compiling-rust-applications-with-cargo",
    ],
    impact: "medium",
    example: {
      bad: 'rustPlatform.buildRustPackage {\n  pname = "app";\n  version = "0.1.0";\n  src = ./.;\n  cargoLock.lockFile = ./Cargo.lock;\n}',
      good: "let\n  craneLib = crane.mkLib pkgs;\n  src = craneLib.cleanCargoSource ./.;\n  commonArgs = { inherit src; strictDeps = true; };\n  cargoArtifacts = craneLib.buildDepsOnly commonArgs;\nin\ncraneLib.buildPackage (commonArgs // { inherit cargoArtifacts; })",
    },
  },
  check({ project, options, report }) {
    const allowed = new Set(options.allow);
    for (const file of lintableNixFiles(project)) {
      if (allowed.has(file.path)) continue;
      if (TWO_PHASE_MARKERS.some((word) => wordOffsets(file, word).length > 0)) continue;
      let count = 0;
      for (const ident of file.idents) {
        if (ident.segments.at(-1) !== "buildRustPackage" || !isValueUse(file, ident)) continue;
        const arg = callArgument(file, ident);
        const open = arg ? attrsetOf(file, arg) : undefined;
        if (open === undefined) continue;
        const source = localSource(file, open);
        if (!source) continue;
        const name = packageName(file, open);
        count += 1;
        report({
          path: file.path,
          line: ident.line,
          message: `\`${ident.text}\`${name ? ` (\`${name}\`)` : ""} uses local source \`${source.text}\`. With standard buildRustPackage phases, \`cargoHash\`/\`cargoLock\` reuse dependency sources rather than compiled artifacts; source changes and a package-cache miss can repeat dependency compilation.`,
          suggestion: `If measurements justify migration, lock and review a crane input (\`crane.url = "github:ipetkov/crane";\`, with committed flake.lock), then adapt a two-phase build:\n\nlet\n  craneLib = crane.mkLib pkgs;\n  src = craneLib.cleanCargoSource ./.;\n  commonArgs = { inherit src; strictDeps = true; };\n  cargoArtifacts = craneLib.buildDepsOnly commonArgs;\nin\ncraneLib.buildPackage (commonArgs // { inherit cargoArtifacts; })\n\nPreserve all build inputs, features, cross-compilation settings, patches and checks. Artifact reuse also depends on toolchain and native dependency compatibility; compare outputs and benchmark rather than assuming this example is equivalent.`,
          confidence: "medium",
          key: `rust-single-phase#${count}`,
        });
      }
    }
  },
});
