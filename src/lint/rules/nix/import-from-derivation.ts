import type { NixArgument, NixFile, NixIdent } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  attrKeys,
  attrsetOf,
  callArgument,
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
  if (ident.segments.length === 1 && last === "fetchurl" && fromBuiltins.has("fetchurl")) return false;
  return isValueUse(file, ident);
}

/** Start of the value of the only `name = ...;` binding in the file (ambiguous names resolve to nothing). */
function uniqueBinding(file: NixFile, name: string): number | undefined {
  const starts: number[] = [];
  for (const offset of wordOffsets(file, name)) {
    if (file.masked[offset - 1] === "." || !isBindingKey(file.masked, offset, name.length)) continue;
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
  const value = uniqueBinding(file, first);
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
      message: `\`${call}\` is import from derivation (IFD): ${source} is a derivation, so evaluation pauses until it is ${
        fetched ? "fetched" : "built"
      } before the rest of the expression can be evaluated. IFD serializes evaluation with building, is not permitted in Nixpkgs, and is rejected by evaluators that set \`allow-import-from-derivation = false\`.`,
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
      const arg = wordCall(file, offset, name);
      if (!arg) continue;
      const qualified = qualifiedName(file, offset, name);
      const hackage = name.startsWith("callHackage");
      findings.push({
        offset,
        line: file.lineOf(offset),
        name,
        message: `\`${qualified}\` is import from derivation (IFD): it runs \`cabal2nix\` in a derivation${
          hackage ? " over the Hackage package index" : ""
        } and imports the generated expression, so evaluation pauses until that derivation is built and repeats it whenever its inputs change. Nixpkgs disallows IFD, and evaluators with \`allow-import-from-derivation = false\` reject it.`,
        suggestion: `Generate the package expression once and commit it: \`${
          hackage ? "cabal2nix cabal://<package>-<version> > nix/<package>.nix" : "cabal2nix . > package.nix"
        }\`, then use \`haskellPackages.callPackage ${hackage ? "./nix/<package>.nix" : "./package.nix"} { }\` (regenerate it when the \`.cabal\` file changes). ${CHECK}`,
        confidence: "high",
      });
    }
  }
  for (const offset of wordOffsets(file, "developPackage")) {
    const arg = wordCall(file, offset, "developPackage");
    const open = arg ? attrsetOf(file, arg) : undefined;
    if (open === undefined || !attrKeys(file, open).has("root")) continue;
    findings.push({
      offset,
      line: file.lineOf(offset),
      name: "developPackage",
      message: `\`${qualifiedName(file, offset, "developPackage")}\` is import from derivation (IFD): it calls \`callCabal2nix\` on \`root\`, so evaluation pauses while \`cabal2nix\` runs in a derivation and repeats whenever the source changes.`,
      suggestion: `Commit a generated expression instead (\`cabal2nix . > package.nix\`) and build it with \`haskellPackages.callPackage ./package.nix { }\`; keep \`developPackage\` only for local development shells where IFD is acceptable. ${CHECK}`,
      confidence: "high",
    });
  }
  for (const offset of wordOffsets(file, "appliedCargoNix")) {
    if (!wordCall(file, offset, "appliedCargoNix")) continue;
    findings.push({
      offset,
      line: file.lineOf(offset),
      name: "appliedCargoNix",
      message: `\`${qualifiedName(file, offset, "appliedCargoNix")}\` is import from derivation (IFD): crate2nix runs \`crate2nix generate\` in a derivation and then \`callPackage\`s the generated \`Cargo.nix\`, so evaluation pauses until that derivation is built and repeats whenever \`Cargo.lock\` or the source changes.`,
      suggestion: `Run \`crate2nix generate\` and commit the resulting \`Cargo.nix\` (regenerate it when \`Cargo.lock\` changes), then use \`(pkgs.callPackage ./Cargo.nix { }).rootCrate.build\`. ${CHECK}`,
      confidence: "high",
    });
  }
  for (const name of YARN_HELPERS) {
    for (const offset of wordOffsets(file, name)) {
      const arg = wordCall(file, offset, name);
      const open = arg ? attrsetOf(file, arg) : undefined;
      if (open === undefined) continue;
      const keys = attrKeys(file, open);
      if (keys.has("offlineCache") || keys.has("yarnNix")) continue;
      findings.push({
        offset,
        line: file.lineOf(offset),
        name,
        message: `\`${qualifiedName(file, offset, name)}\` without \`offlineCache\` or \`yarnNix\` is import from derivation (IFD): yarn2nix converts \`yarn.lock\` into \`yarn.nix\` in a derivation and then imports it, so evaluation pauses until it is built and repeats whenever \`yarn.lock\` changes.`,
        suggestion: `Pass a fixed-output dependency cache instead: \`offlineCache = fetchYarnDeps { yarnLock = ./yarn.lock; hash = "<SRI hash from the first build's hash mismatch>"; };\` (or commit the output of \`yarn2nix\` and set \`yarnNix = ./yarn.nix;\`). For new packages, prefer \`stdenv.mkDerivation\` with \`yarnOfflineCache = fetchYarnDeps { ... };\` and \`yarnConfigHook\`/\`yarnBuildHook\`/\`yarnInstallHook\`. ${CHECK}`,
        confidence: "high",
      });
    }
  }
  for (const offset of wordOffsets(file, "autoPubspecLock")) {
    if (file.masked[offset - 1] === "." || !isBindingKey(file.masked, offset, "autoPubspecLock".length)) continue;
    findings.push({
      offset,
      line: file.lineOf(offset),
      name: "autoPubspecLock",
      message:
        "`autoPubspecLock` is import from derivation (IFD): the Dart builder converts `pubspec.lock` to Nix in a derivation and imports the result during evaluation, which Nixpkgs does not permit.",
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
      "Import from derivation (IFD) happens when evaluation needs the contents of a store path that must first be built or fetched by a derivation: `import`, `builtins.readFile`, `lib.importJSON` or `callPackage` applied to the output of `runCommand`, `fetchFromGitHub`, a cabal2nix/crate2nix/yarn2nix generator, and so on. The evaluator must stop, realise that derivation, and only then continue, so evaluation and building serialize instead of producing the full build graph up front; the work repeats whenever the generator's inputs change, and evaluators that set `allow-import-from-derivation = false` (as Nixpkgs requires) reject the expression outright. Committing generated Nix code, or moving the work into a build phase, keeps evaluation pure and fast.",
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
