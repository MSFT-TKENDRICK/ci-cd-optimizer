import { identsEndingWith, nixBindings } from "../../parsers/nix.js";
import type { NixFile } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { assignedKey, inLambdaDefault, isValueUse, lintableNixFiles, previousNonSpace, skipSpace, snippet, stringAt, validateStringLists } from "./expr.js";

const FAKE_NAMES = ["fakeHash", "fakeSha256", "fakeSha512"];
const HASH_KEYS = [
  "hash",
  "sha256",
  "sha512",
  "outputHash",
  "cargoHash",
  "cargoSha256",
  "vendorHash",
  "vendorSha256",
  "npmDepsHash",
  "mvnHash",
  "nugetHash",
  "lakeHash",
];
const EMPTY_HASH = new RegExp(`(?<![A-Za-z0-9_'-])(${HASH_KEYS.join("|")})\\s*=(?!=)\\s*"`, "g");
const OUTPUT_HASHES = /(?<![A-Za-z0-9_'-])outputHashes\s*=\s*\{/g;
const OUTPUT_HASH_DOTTED = /(?<![A-Za-z0-9_'-])outputHashes\s*\.\s*("[^"]*"|[A-Za-z_][A-Za-z0-9_'-]*)\s*=(?!=)\s*"/g;
const SRI_PLACEHOLDER = /^(?:sha1|sha256|sha512)-A{20,}=*$/;
const ZERO_PLACEHOLDER = /^(?:sha(?:1|256|512):)?0{32,}$/;
// Flake templates are meant to be copied and filled in; a placeholder hash there is intentional.
const TEMPLATE_DIR = /(?:^|\/)templates?\//;

interface Finding {
  offset: number;
  line: number;
  key?: string;
  shown: string;
}

/** An attribute name as it must be written in Nix source (quoted unless it is a plain identifier). */
function attrName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) ? name : `"${name}"`;
}

function ignored(path: string, ignore: readonly string[]): boolean {
  return TEMPLATE_DIR.test(path) || ignore.some((entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`));
}

function comparedWith(file: NixFile, start: number, end: number): boolean {
  const { masked } = file;
  const before = previousNonSpace(masked, start);
  const after = skipSpace(masked, end);
  return (masked[before] === "=" && "=!".includes(masked[before - 1] ?? "")) || ((masked[after] === "=" || masked[after] === "!") && masked[after + 1] === "=");
}

function findings(file: NixFile): Finding[] {
  const found = new Map<number, Finding>();
  const add = (offset: number, shown: string, key: string | undefined): void => {
    if (!found.has(offset)) found.set(offset, { offset, line: file.lineOf(offset), ...(key ? { key } : {}), shown });
  };
  for (const name of FAKE_NAMES) {
    for (const ident of identsEndingWith(file, name)) {
      if (!isValueUse(file, ident) || comparedWith(file, ident.offset, ident.end) || inLambdaDefault(file.masked, ident.offset)) continue;
      add(ident.offset, ident.text, assignedKey(file.masked, ident.offset));
    }
  }
  for (const match of file.masked.matchAll(EMPTY_HASH)) {
    const quote = match.index + match[0].length - 1;
    const string = stringAt(file, quote);
    if (!string || string.interpolated || string.indented || string.value !== "") continue;
    add(quote, '""', match[1]);
  }
  for (const match of file.masked.matchAll(OUTPUT_HASHES)) {
    for (const binding of nixBindings(file, match.index + match[0].length - 1)) {
      const string = stringAt(file, binding.valueStart);
      if (!string || string.interpolated || string.value !== "") continue;
      add(string.start, '""', `outputHashes.${binding.path.map(attrName).join(".")}`);
    }
  }
  for (const match of file.masked.matchAll(OUTPUT_HASH_DOTTED)) {
    const quote = match.index + match[0].length - 1;
    const string = stringAt(file, quote);
    if (!string || string.interpolated || string.value !== "") continue;
    const name = match[1] ?? "";
    const keyString = name.startsWith('"') ? stringAt(file, match.index + match[0].indexOf('"')) : undefined;
    add(quote, '""', `outputHashes.${attrName(keyString ? keyString.value : name)}`);
  }
  for (const string of file.strings) {
    if (string.interpolated) continue;
    const key = assignedKey(file.masked, string.start);
    if (key?.toLowerCase().startsWith("fake")) continue;
    if (SRI_PLACEHOLDER.test(string.value) || (ZERO_PLACEHOLDER.test(string.value) && key !== undefined && /hash|sha/i.test(key))) {
      add(string.start, `"${snippet(file, string.start + 1, string.end - 1, 24)}"`, key);
    }
  }
  return [...found.values()].sort((a, b) => a.offset - b.offset);
}

export default defineRule({
  meta: {
    id: "nix/fake-hash-committed",
    ruleset: "nix",
    description: "Placeholder hashes (`lib.fakeHash`, `\"\"`, all-zero or `sha256-AAAA…` values) must not be committed.",
    rationale:
      "The nixpkgs \"fake hash method\" sets a fixed-output derivation's hash to `\"\"`, `lib.fakeHash`, `lib.fakeSha256` or `lib.fakeSha512` so that one build fails and prints the real hash (`specified: … got: …`). It is a local workflow step: a fixed-output derivation whose declared hash can never match its content fails on every machine, so once committed the package, everything that depends on it and every CI job that builds it are broken until someone copies the real hash in. Only these well-known placeholders are reported; `vendorHash = null` (Go with a vendored `vendor/` directory) is not a placeholder and is not reported.",
    kind: "policy",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { ignorePaths: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "ignorePaths"),
    references: [
      "https://nixos.org/manual/nixpkgs/stable/#sec-pkgs-fetchers-updating-source-hashes-fakehash-method",
      "https://nixos.org/manual/nixpkgs/stable/#var-go-vendorHash",
      "https://nixos.org/manual/nixpkgs/stable/#compiling-rust-applications-with-cargo",
    ],
    impact: "high",
    example: {
      bad: 'rustPlatform.buildRustPackage {\n  pname = "tool";\n  cargoHash = lib.fakeHash;\n}',
      good: 'rustPlatform.buildRustPackage {\n  pname = "tool";\n  cargoHash = "sha256-<hash printed as `got:` by the failed build>";\n}',
    },
  },
  check({ project, options, report }) {
    for (const file of lintableNixFiles(project)) {
      if (ignored(file.path, options.ignorePaths)) continue;
      let count = 0;
      for (const finding of findings(file)) {
        count += 1;
        const key = finding.key ?? "hash";
        const label = finding.key ? `\`${finding.key} = ${finding.shown}\`` : `\`${finding.shown}\``;
        const vendor = /^vendor(?:Hash|Sha256)$/.test(key);
        report({
          path: file.path,
          line: finding.line,
          message: `${label} is a placeholder hash: the fixed-output derivation can never match it, so every build of this package (and of everything that depends on it) fails with a hash mismatch until the real hash is committed.`,
          suggestion: [
            `Build once (\`nix build\` / \`nix-build\`), copy the \`got:\` value from the "hash mismatch in fixed-output derivation" error and commit it:`,
            "",
            `${key} = "sha256-<value printed after got:>";`,
            ...(vendor ? ["", "If the module has no dependencies outside a committed `vendor/` directory, use `vendorHash = null;` instead."] : []),
          ].join("\n"),
          confidence: "high",
          key: `${key}#${count}`,
        });
      }
    }
  },
});
