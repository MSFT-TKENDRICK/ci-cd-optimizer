import type { NixArgument, NixFile, NixIdent } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  attrKeys,
  attrsetOf,
  callArgument,
  enclosingOpen,
  headIdent,
  inheritedFromBuiltins,
  isBindingKey,
  isShadowed,
  isValueUse,
  lintableNixFiles,
  skipLetIn,
  skipSpace,
  snippet,
  stringAt,
  unwrapParens,
  validateStringLists,
  wordOffsets,
} from "./expr.js";

/** Functions whose result is a derivation (or its output path) rather than an evaluation-time value. */
const PRODUCERS = new Set([
  "runCommand",
  "runCommandLocal",
  "runCommandCC",
  "runCommandNoCC",
  "runCommandNoCCLocal",
  "writeText",
  "writeTextFile",
  "writeTextDir",
  "writeScript",
  "applyPatches",
  "mkDerivation",
  "fetchFromGitHub",
  "fetchFromGitLab",
  "fetchFromGitea",
  "fetchFromSourcehut",
  "fetchFromBitbucket",
  "fetchgit",
  "fetchzip",
  "fetchurl",
  "generatedCargoNix",
  "haskellSrc2nix",
]);
const FETCHERS = /^fetch/;
const BUILTIN_READERS = new Set(["readFile", "readDir", "pathExists", "readFileType"]);
const LIB_READERS = new Set(["importJSON", "importTOML", "fileContents"]);
const OUTPUT_ATTRS = new Set(["out", "outPath"]);
const HASKELL_HELPERS = new Set(["callCabal2nix", "callCabal2nixWithOptions", "callHackage", "callHackageDirect"]);
const YARN_HELPERS = new Set(["mkYarnPackage", "mkYarnModules"]);
const CHECK = "Verify with `nix build --option allow-import-from-derivation false` (or set it in `nix.conf`) so new IFD fails fast.";

interface Origin {
  producer: string;
  line: number;
  /** Local name the producer was bound to, when the consumer referenced it indirectly. */
  via?: string;
}

interface Finding {
  offset: number;
  line: number;
  name: string;
  message: string;
  suggestion: string;
  confidence: "high" | "medium";
}

function isProducer(file: NixFile, ident: NixIdent, fromBuiltins: Set<string>): boolean {
  const last = ident.segments.at(-1) ?? "";
  if (!PRODUCERS.has(last) || ident.segments[0] === "builtins") return false;
  if (ident.segments.length === 1 && isShadowed(file, last)) return false;
  if (ident.segments.length === 1 && last === "fetchurl" && fromBuiltins.has("fetchurl")) return false;
  return isValueUse(file, ident);
}

/** Start of the value of the only `name = ...;` binding in the file (ambiguous names resolve to nothing). */
function uniqueBinding(file: NixFile, name: string, reference: number): number | undefined {
  if (wordOffsets(file, "let").length > 1) return undefined;
  const starts: number[] = [];
  for (const offset of wordOffsets(file, name)) {
    if (file.masked[offset - 1] === "." || !isBindingKey(file.masked, offset, name.length)) continue;
    const scope = enclosingOpen(file.masked, offset);
    let enclosing = enclosingOpen(file.masked, reference);
    while (enclosing >= 0 && enclosing !== scope) enclosing = enclosingOpen(file.masked, enclosing);
    if (scope !== enclosing) continue;
    starts.push(skipSpace(file.masked, skipSpace(file.masked, offset + name.length) + 1));
  }
  return starts.length === 1 ? starts[0] : undefined;
}

function producerAt(file: NixFile, offset: number, fromBuiltins: Set<string>, depth: number): Origin | undefined {
  const head = headIdent(file, skipLetIn(file.masked, offset));
  if (!head) return undefined;
  if (isProducer(file, head, fromBuiltins)) return { producer: head.text, line: head.line };
  if (depth > 0) return undefined;
  const [first, second] = head.segments;
  if (!first || (second !== undefined && (head.segments.length > 2 || !OUTPUT_ATTRS.has(second)))) return undefined;
  const value = uniqueBinding(file, first, head.offset);
  if (value === undefined) return undefined;
  const origin = producerAt(file, value, fromBuiltins, depth + 1);
  return origin ? { ...origin, via: first } : undefined;
}

/** The derivation-producing expression a consumer argument evaluates, when it can be resolved in this file. */
function producerOf(file: NixFile, arg: NixArgument, fromBuiltins: Set<string>): Origin | undefined {
  const unwrapped = unwrapParens(file, arg);
  if (unwrapped.kind === "string") {
    const string = stringAt(file, unwrapped.start);
    if (!string?.interpolated) return undefined;
    const body = string.start + (string.indented ? 2 : 1);
    if (file.content.slice(body, body + 2) !== "${") return undefined;
    return producerAt(file, body + 2, fromBuiltins, 0);
  }
  if (unwrapped.kind === "paren") return producerAt(file, unwrapped.start + 1, fromBuiltins, 0);
  if (unwrapped.kind === "other") return producerAt(file, unwrapped.start, fromBuiltins, 0);
  return undefined;
}

function consumerKind(file: NixFile, ident: NixIdent, fromBuiltins: Set<string>): "import" | "read" | undefined {
  const { text, segments } = ident;
  if (segments.length === 1 && isShadowed(file, text)) return undefined;
  if (segments[0] === "builtins" && isShadowed(file, "builtins")) return undefined;
  const last = segments.at(-1) ?? "";
  if (text === "import" || text === "builtins.import") return "import";
  if (last === "callPackage") return "import";
  if (segments.length === 2 && segments[0] === "builtins" && BUILTIN_READERS.has(last)) return "read";
  if (segments.length === 1 && BUILTIN_READERS.has(last) && fromBuiltins.has(last) && !isShadowed(file, last)) return "read";
  if (segments.length >= 2 && segments.includes("lib") && LIB_READERS.has(last)) return "read";
  return undefined;
}

function consumerFindings(file: NixFile): Finding[] {
  const fromBuiltins = inheritedFromBuiltins(file);
  const findings: Finding[] = [];
  for (const ident of file.idents) {
    const kind = consumerKind(file, ident, fromBuiltins);
    if (!kind) continue;
    const arg = callArgument(file, ident);
    if (!arg) continue;
    const origin = producerOf(file, arg, fromBuiltins);
    if (!origin) continue;
    const call = `${ident.text} ${snippet(file, arg.start, arg.end, 50)}`;
    const source = origin.via ? `\`${origin.via}\` (built by \`${origin.producer}\` on line ${origin.line})` : `\`${origin.producer}\``;
    const fetched = FETCHERS.test(origin.producer.split(".").at(-1) ?? "");
    const fix =
      kind === "import"
        ? "Generate the Nix code ahead of time and commit it (for example `import ./generated.nix`), regenerating it with a script or CI job when its inputs change."
        : "Inline the value in Nix, or commit the file and read it through a path literal (`builtins.readFile ./VERSION`), or move the logic that needs it into a build phase that reads `$src/...` at build time.";
    findings.push({
      offset: ident.offset,
      line: ident.line,
      name: ident.text,
      message: `\`${call}\` matches import from derivation (IFD): assuming the recognized functions have their standard semantics, ${source} supplies a derivation output. If demanded and not already available, evaluation waits for it to be ${
        fetched ? "fetched" : "built"
      }. Evaluators with \`allow-import-from-derivation = false\` reject demanded IFD; this does not establish how much work a cached evaluation performs.`,
      suggestion: `${fix}${
        fetched
          ? " To pin external Nix code such as nixpkgs, use a flake input or `builtins.fetchTarball { url = \"https://github.com/<owner>/<repo>/archive/<rev>.tar.gz\"; sha256 = \"<hash>\"; }`, which fetch during evaluation without building a derivation."
          : ""
      } ${CHECK}`,
      confidence: origin.via ? "medium" : "high",
    });
  }
  return findings;
}

/** The argument `name` is applied to at a word offset; also matches `haskell.packages.${compiler}.callCabal2nix`. */
function wordCall(file: NixFile, offset: number, name: string): NixArgument | undefined {
  const ident: NixIdent = { text: name, segments: [name], offset, end: offset + name.length, line: file.lineOf(offset) };
  return callArgument(file, ident);
}

/** Text of the dotted reference ending at `offset + name.length` (`haskellPackages.callCabal2nix`). */
function qualifiedName(file: NixFile, offset: number, name: string): string {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_'.${}-]/.test(file.masked[start - 1] ?? "")) start -= 1;
  return file.content.slice(start, offset + name.length).replace(/^[^A-Za-z_]+/, "");
}

function helperFindings(file: NixFile): Finding[] {
  const findings: Finding[] = [];
  for (const name of HASKELL_HELPERS) {
    for (const offset of wordOffsets(file, name)) {
      if (isShadowed(file, name)) continue;
      const arg = wordCall(file, offset, name);
      if (!arg) continue;
      const qualified = qualifiedName(file, offset, name);
      const hackage = name.startsWith("callHackage");
      findings.push({
        offset,
        line: file.lineOf(offset),
        name,
        message: `\`${qualified}\` matches a standard Haskell import-from-derivation (IFD) helper: it normally runs \`cabal2nix\` in a derivation${
          hackage ? " over the Hackage package index" : ""
        } and imports the result when demanded. Available outputs may avoid rebuilding. Confirm the binding and IFD policy before changing it.`,
        suggestion: `Generate the package expression once and commit it: \`${
          hackage ? "cabal2nix cabal://<package>-<version> > nix/<package>.nix" : "cabal2nix . > package.nix"
        }\`, then use \`haskellPackages.callPackage ${hackage ? "./nix/<package>.nix" : "./package.nix"} { }\` (regenerate it when the \`.cabal\` file changes). ${CHECK}`,
        confidence: "high",
      });
    }
  }
  for (const offset of wordOffsets(file, "developPackage")) {
    const qualified = qualifiedName(file, offset, "developPackage");
    if (!/haskell/i.test(qualified) || isShadowed(file, "developPackage")) continue;
    const arg = wordCall(file, offset, "developPackage");
    const open = arg ? attrsetOf(file, arg) : undefined;
    if (open === undefined || !attrKeys(file, open).has("root")) continue;
    findings.push({
      offset,
      line: file.lineOf(offset),
      name: "developPackage",
      message: `\`${qualified}\` with \`root\` matches the standard Haskell import-from-derivation helper. When demanded, it may need a cabal2nix derivation before evaluation continues; cached outputs and custom bindings can change the observed work.`,
      suggestion: `Commit a generated expression instead (\`cabal2nix . > package.nix\`) and build it with \`haskellPackages.callPackage ./package.nix { }\`; keep \`developPackage\` only for local development shells where IFD is acceptable. ${CHECK}`,
      confidence: "high",
    });
  }
  for (const offset of wordOffsets(file, "appliedCargoNix")) {
    if (isShadowed(file, "appliedCargoNix")) continue;
    if (!wordCall(file, offset, "appliedCargoNix")) continue;
    findings.push({
      offset,
      line: file.lineOf(offset),
      name: "appliedCargoNix",
      message: `\`${qualifiedName(file, offset, "appliedCargoNix")}\` matches crate2nix's import-from-derivation helper. With its standard semantics, demanded evaluation may need generated Cargo.nix before continuing; cached outputs and custom bindings can avoid the assumed work.`,
      suggestion: `Run \`crate2nix generate\` and commit the resulting \`Cargo.nix\` (regenerate it when \`Cargo.lock\` changes), then use \`(pkgs.callPackage ./Cargo.nix { }).rootCrate.build\`. ${CHECK}`,
      confidence: "high",
    });
  }
  for (const name of YARN_HELPERS) {
    for (const offset of wordOffsets(file, name)) {
      if (isShadowed(file, name)) continue;
      const arg = wordCall(file, offset, name);
      const open = arg ? attrsetOf(file, arg) : undefined;
      if (open === undefined) continue;
      const keys = attrKeys(file, open);
      if (keys.has("offlineCache") || keys.has("yarnNix")) continue;
      findings.push({
        offset,
        line: file.lineOf(offset),
        name,
        message: `\`${qualifiedName(file, offset, name)}\` without \`offlineCache\` or \`yarnNix\` matches a conventional yarn2nix import-from-derivation path. If demanded under those helper semantics, evaluation may need generated yarn.nix; existing outputs and helper versions affect the work.`,
        suggestion: `Pass a fixed-output dependency cache instead: \`offlineCache = fetchYarnDeps { yarnLock = ./yarn.lock; hash = "<SRI hash from the first build's hash mismatch>"; };\` (or commit the output of \`yarn2nix\` and set \`yarnNix = ./yarn.nix;\`). For new packages, prefer \`stdenv.mkDerivation\` with \`yarnOfflineCache = fetchYarnDeps { ... };\` and \`yarnConfigHook\`/\`yarnBuildHook\`/\`yarnInstallHook\`. ${CHECK}`,
        confidence: "high",
      });
    }
  }
  for (const offset of wordOffsets(file, "autoPubspecLock")) {
    if (file.masked[offset - 1] === "." || !isBindingKey(file.masked, offset, "autoPubspecLock".length)) continue;
    const value = skipSpace(file.masked, skipSpace(file.masked, offset + "autoPubspecLock".length) + 1);
    if (/^(?:true|false|null)\b/.test(file.masked.slice(value))) continue;
    const open = enclosingOpen(file.masked, offset);
    const builder = file.idents.some((ident) => {
      if (!["buildDartApplication", "buildFlutterApplication"].includes(ident.segments.at(-1) ?? "")) return false;
      const arg = callArgument(file, ident);
      return arg !== undefined && attrsetOf(file, arg) === open;
    });
    if (!builder) continue;
    findings.push({
      offset,
      line: file.lineOf(offset),
      name: "autoPubspecLock",
      message:
        "`autoPubspecLock` in a recognized Dart/Flutter builder matches a conventional import-from-derivation path. Confirm the builder version and binding: demanded conversion may require a derivation output during evaluation, subject to the evaluator's IFD policy and available outputs.",
      suggestion: `Convert the lock file once and commit it: \`yq . pubspec.lock > pubspec.lock.json\`, then set \`pubspecLock = lib.importJSON ./pubspec.lock.json;\` (regenerate it when \`pubspec.lock\` changes). ${CHECK}`,
      confidence: "high",
    });
  }
  return findings;
}

function allowed(path: string, names: string[], allow: string[]): boolean {
  return allow.some((entry) => entry === path || (entry.endsWith("/") && path.startsWith(entry)) || names.includes(entry));
}

export default defineRule({
  meta: {
    id: "nix/import-from-derivation",
    ruleset: "nix",
    description: "Nix expressions should not import or read files produced by a derivation during evaluation (import from derivation).",
    rationale:
      "IFD demands derivation output during evaluation. If unavailable, it may need realization before evaluation continues, and evaluators disabling IFD reject demanded uses. Existing store outputs or substitutes can avoid rebuilding. This lexical detector recognizes conventional producers/readers and selected helpers; it cannot resolve arbitrary bindings, laziness or runtime cost. IFD is not itself proof of impurity. Committing generated code or moving generation to build time can remove an evaluation dependency, but needs regeneration policy and behavioral testing.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { allow: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "allow"),
    references: [
      "https://nix.dev/manual/nix/stable/language/import-from-derivation.html",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-allow-import-from-derivation",
      "https://nixos.org/manual/nixpkgs/stable/#haskell-import-from-derivation",
      "https://nixos.org/manual/nixpkgs/stable/#ssec-dart-applications",
      "https://nixos.org/manual/nixpkgs/stable/#javascript-yarn-v1",
    ],
    impact: "high",
    example: {
      bad: 'let\n  generated = pkgs.runCommand "deps.nix" { } "${pkgs.mytool}/bin/gen > $out";\nin\nimport generated { inherit pkgs; }',
      good: "# Run the generator once and commit its output:\n#   mytool > nix/deps.nix\nimport ./nix/deps.nix { inherit pkgs; }",
    },
  },
  check({ project, options, report }) {
    for (const file of lintableNixFiles(project)) {
      const findings = [...consumerFindings(file), ...helperFindings(file)].sort((a, b) => a.offset - b.offset);
      const seen = new Map<string, number>();
      const reported = new Set<number>();
      for (const finding of findings) {
        if (reported.has(finding.offset) || allowed(file.path, [finding.name, finding.name.split(".").at(-1) ?? ""], options.allow)) continue;
        reported.add(finding.offset);
        const name = finding.name.split(".").at(-1) ?? finding.name;
        const count = (seen.get(name) ?? 0) + 1;
        seen.set(name, count);
        report({
          path: file.path,
          line: finding.line,
          message: finding.message,
          suggestion: finding.suggestion,
          confidence: finding.confidence,
          key: `ifd:${name}#${count}`,
        });
      }
    }
  },
});
