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
  if (ident.segments.includes("fileset") || LOCAL_SOURCE_HELPERS.has(last) || ident.text === "nix-gitignore.gitignoreSource") return true;
  if (ident.text === "builtins.path") return true;
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
      "`rustPlatform.buildRustPackage` vendors crate sources into a fixed-output derivation (`cargoHash`/`cargoLock`), but compiles every dependency and the workspace itself with one `cargo build` inside a single derivation whose inputs include `src`. When `src` is the repository itself, every commit changes that derivation's hash, so the binary cache never has a match and CI recompiles every dependency crate from scratch. crane's `buildDepsOnly` builds only the dependencies (from a dummy source derived from `Cargo.toml`/`Cargo.lock`) into `cargoArtifacts`, which `buildPackage` reuses, so routine source changes only rebuild the workspace crates and the dependency derivation stays cached until `Cargo.lock` changes.",
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
          message: `\`${ident.text}\`${name ? ` (\`${name}\`)` : ""} compiles all dependency crates and the workspace in one derivation from local source \`${source.text}\`: \`cargoHash\`/\`cargoLock\` only caches crate downloads, so every source change produces a new derivation and recompiles every dependency from scratch with no binary-cache hit.`,
          suggestion: `Split dependency compilation into its own derivation with crane (flake input \`crane.url = "github:ipetkov/crane";\`):\n\nlet\n  craneLib = crane.mkLib pkgs;\n  src = craneLib.cleanCargoSource ./.;\n  commonArgs = { inherit src; strictDeps = true; };\n  cargoArtifacts = craneLib.buildDepsOnly commonArgs;\nin\ncraneLib.buildPackage (commonArgs // { inherit cargoArtifacts; })\n\n\`buildDepsOnly\` only changes when \`Cargo.toml\`/\`Cargo.lock\` change, so its output is reused from the binary cache across commits; reuse \`cargoArtifacts\` for \`cargoClippy\`/\`cargoNextest\` checks as well.`,
          confidence: "medium",
          key: `rust-single-phase#${count}`,
        });
      }
    }
  },
});
