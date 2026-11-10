import { nixBindings } from "../../parsers/nix.js";
import type { NixFile } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  assignedKey,
  enclosingBindingPath,
  enclosingOpen,
  inheritStatements,
  lintableNixFiles,
  previousNonSpace,
  previousWord,
  skipLetIn,
  skipSpace,
  snippet,
  validateStringLists,
} from "./expr.js";

const DEFAULT_PACKAGES = ["stdenv", "glibc", "openssl", "zlib", "gcc", "binutils", "bash", "coreutils", "python3", "perl", "curl", "systemd"];
// Built inside the stdenv bootstrap stages, which also receive the user's overlays (pkgs/stdenv/booter.nix).
const BOOTSTRAP = new Set(["glibc", "gcc", "binutils", "coreutils", "zlib", "bash", "bashNonInteractive", "gnumake", "gnused", "gnugrep", "gawk", "findutils", "diffutils", "gnutar", "gzip", "bzip2", "xz", "patchelf"]);
const OVERLAY_LAMBDA = /(?<![A-Za-z0-9_'.-])(final|self|_final|_self|_)\s*:\s*(prev|super|_prev|_super|_)\s*:/g;
const PACKAGE_SETS = new Set(["prev", "super", "final", "self"]);
const NON_OVERLAY_KEY = /^(?:packageOverrides|overrides|overrideScope'?|.*Extensions|.*Packages)$/;

interface Rebinding {
  name: string;
  offset: number;
  shown: string;
}

function callHead(masked: string, open: number): string | undefined {
  return masked.slice(0, open).match(/([A-Za-z_][A-Za-z0-9_'.-]*)\s*$/)?.[1];
}

function isOverlayContext(file: NixFile, lambda: number): boolean {
  const { masked } = file;
  const key = assignedKey(masked, lambda);
  if (key !== undefined && NON_OVERLAY_KEY.test(key)) return false;
  if (key !== undefined && /overlay/i.test(key)) return true;
  const open = enclosingOpen(file, lambda);
  if (open < 0) {
    const before = previousNonSpace(masked, lambda);
    const topLevel = before < 0 || masked[before] === ":" || previousWord(masked, lambda) === "in";
    return topLevel && /overlay/i.test(file.path);
  }
  if (masked[open] === "(") {
    if (/(?:^|\.)(?:extend|composeExtensions)$/.test(callHead(masked, open) ?? "")) return true;
    const list = enclosingOpen(file, open);
    if (list >= 0 && masked[list] === "[" && /(?:^|\.)(?:appendOverlays|composeManyExtensions)$/.test(callHead(masked, list) ?? "")) return true;
  }
  const path = enclosingBindingPath(file, lambda);
  if (!path) return false;
  const last = path[path.length - 1] ?? "";
  return !NON_OVERLAY_KEY.test(last) && path.some((segment) => /^overlays?$/.test(segment));
}

function overlayBody(masked: string, afterLambda: number): number | undefined {
  let cursor = skipLetIn(masked, afterLambda);
  const withMatch = /^with(?![A-Za-z0-9_'-])[^;]*;/.exec(masked.slice(cursor));
  if (withMatch) cursor = skipLetIn(masked, cursor + withMatch[0].length);
  if (/^rec(?![A-Za-z0-9_'-])/.test(masked.slice(cursor))) cursor = skipSpace(masked, cursor + 3);
  return masked[cursor] === "{" ? cursor : undefined;
}

function rebindings(file: NixFile, open: number, watched: ReadonlySet<string>): Rebinding[] {
  const found: Rebinding[] = [];
  for (const binding of nixBindings(file, open)) {
    const name = binding.path[0];
    if (binding.path.length !== 1 || name === undefined || !watched.has(name)) continue;
    const value = file.masked.slice(binding.valueStart, binding.valueEnd).trim().replace(/;$/, "").trim();
    if (new RegExp(`^(?:prev|super|final|self)\\.${name}$`).test(value)) continue;
    // `python3.override { packageOverrides = ...; }` changes the Python package set, not the interpreter.
    if (/^python/.test(name) && /(?<![A-Za-z0-9_'-])packageOverrides(?![A-Za-z0-9_'-])/.test(value)) continue;
    found.push({ name, offset: binding.keyStart, shown: `${name} = ${snippet(file, binding.valueStart, binding.valueEnd, 50).replace(/;$/, "")}` });
  }
  for (const statement of inheritStatements(file)) {
    if (statement.source === undefined || PACKAGE_SETS.has(statement.source) || enclosingOpen(file, statement.offset) !== open) continue;
    for (const entry of statement.names) {
      if (watched.has(entry.name)) found.push({ name: entry.name, offset: entry.offset, shown: `inherit (${statement.source}) ${entry.name}` });
    }
  }
  return found;
}

function blastRadius(name: string): string {
  if (name === "stdenv") {
    return "a changed `stdenv` can affect a large part of the package graph";
  }
  if (BOOTSTRAP.has(name)) {
    return `overlays are also applied inside the nixpkgs stdenv bootstrap stages and \`${name}\` is built there, so this can change the standard environment itself and give essentially every package a new store path`;
  }
  return `a derivation-changing replacement can affect packages that depend on \`${name}\`, directly or transitively`;
}

function scopedSuggestion(name: string): string {
  if (name === "stdenv") {
    return [
      "Swap the stdenv only for the packages that need it:",
      "",
      "final: prev: {",
      "  myApp = prev.myApp.override { stdenv = final.clangStdenv; };",
      "}",
    ].join("\n");
  }
  return [
    `Leave \`${name}\` alone and scope the change to the packages that need it, or publish it under a new name:`,
    "",
    "final: prev: {",
    `  myApp = prev.myApp.override { ${name} = final.${name}_custom; };`,
    `  ${name}_custom = prev.${name}.overrideAttrs (old: { /* ... */ });`,
    "}",
    ...(name.startsWith("python")
      ? ["", "To change Python packages for every interpreter, append to `pythonPackagesExtensions` instead of replacing the interpreter:", "", "pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [ (pyFinal: pyPrev: { /* ... */ }) ];"]
      : []),
  ].join("\n");
}

export default defineRule({
  meta: {
    id: "nix/overlay-overrides-foundational-package",
    ruleset: "nix",
    description: "Overlays should not globally replace foundational packages such as `stdenv`, `glibc`, `openssl` or `zlib`.",
    rationale:
      "A package-set overlay can change inputs widely, especially foundational libraries and bootstrap packages. Rebinding alone does not establish changed derivations: metadata-only overrides or equivalent values can retain store paths, and changed outputs may already exist in a cache. Evaluate the before/after derivation graph and substitutability before deciding whether to narrow an intentional override. Scoped overrides also change dependency policy and require testing.",
    kind: "insight",
    defaultSeverity: "warn",
    presets: ["strict", "insights"],
    requires: [],
    defaultOptions: { packages: DEFAULT_PACKAGES, allow: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "packages", "allow"),
    references: [
      "https://nixos.org/manual/nixpkgs/stable/#sec-overlays-definition",
      "https://nixos.org/manual/nixpkgs/stable/#sec-pkg-override",
      "https://nixos.org/manual/nixpkgs/stable/#how-to-override-a-python-package-for-all-python-versions-using-extensions",
      "https://github.com/NixOS/nixpkgs/blob/master/pkgs/stdenv/booter.nix",
      "https://github.com/NixOS/nixpkgs/blob/master/pkgs/top-level/stage.nix",
    ],
    impact: "high",
    example: {
      bad: "overlays.default = final: prev: {\n  openssl = prev.openssl.overrideAttrs (old: { configureFlags = old.configureFlags ++ [ \"no-weak-ssl-ciphers\" ]; });\n};",
      good: "overlays.default = final: prev: {\n  myApp = prev.myApp.override {\n    openssl = final.openssl.overrideAttrs (old: { configureFlags = old.configureFlags ++ [ \"no-weak-ssl-ciphers\" ]; });\n  };\n};",
    },
  },
  check({ project, options, report }) {
    const allowed = new Set(options.allow);
    const watched = new Set(options.packages.filter((name) => !allowed.has(name)));
    if (watched.size === 0) return;
    for (const file of lintableNixFiles(project)) {
      const seen = new Map<string, number>();
      const reported = new Set<number>();
      for (const match of file.masked.matchAll(OVERLAY_LAMBDA)) {
        if (!isOverlayContext(file, match.index)) continue;
        const open = overlayBody(file.masked, match.index + match[0].length);
        if (open === undefined) continue;
        const findings = rebindings(file, open, watched).sort((a, b) => a.offset - b.offset);
        for (const finding of findings) {
          if (reported.has(finding.offset)) continue;
          reported.add(finding.offset);
          const count = (seen.get(finding.name) ?? 0) + 1;
          seen.set(finding.name, count);
          report({
            path: file.path,
            line: file.lineOf(finding.offset),
            message: `Overlay rebinds \`${finding.shown}\` for the whole package set: ${blastRadius(finding.name)}. Compare resulting derivations and available substitutes; syntax alone does not establish changed store paths or cache misses.`,
            suggestion: `${scopedSuggestion(finding.name)}\n\nIf the global override is intended, push the rebuilt closure to a binary cache your CI and developers use (Cachix, Attic, or \`nix copy --to s3://...\`) and add \`${finding.name}\` to this rule's \`allow\` option.`,
            confidence: "medium",
            key: `overlay:${finding.name}#${count}`,
          });
        }
      }
    }
  },
});
