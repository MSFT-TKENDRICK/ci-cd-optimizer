import { argumentAfter, matchingClose, nixBindings } from "../../parsers/nix.js";
import type { NixArgument, NixBinding, NixFile, NixIdent, NixString } from "../../parsers/nix.js";
import type { ProjectModel } from "../../project.js";

/** Shared expression-level helpers for rules that scan `*.nix` source with the lossless scanner. */

const IDENT_CHAR = /[A-Za-z0-9_'-]/;
const NAME = /[A-Za-z_][A-Za-z0-9_'-]*/g;
const KEYWORDS = new Set(["then", "else", "in", "or", "let", "with", "assert", "if", "inherit", "rec"]);
const OPERATOR = /^(?:\+|\*|==|!=|&&|\|\||->|\/\/|<=|>=|<(?![A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*>)|>|\?|-$)/;

export function skipSpace(masked: string, index: number): number {
  let cursor = index;
  while (cursor < masked.length && /\s/.test(masked[cursor] ?? "")) cursor += 1;
  return cursor;
}

/** Index of the last non-whitespace character strictly before `index`, or -1. */
export function previousNonSpace(masked: string, index: number): number {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(masked[cursor] ?? "")) cursor -= 1;
  return cursor;
}

/** The word (identifier or keyword) ending just before `index`, ignoring whitespace. */
export function previousWord(masked: string, index: number): string | undefined {
  const end = previousNonSpace(masked, index) + 1;
  let start = end;
  while (start > 0 && IDENT_CHAR.test(masked[start - 1] ?? "")) start -= 1;
  return start < end ? masked.slice(start, end) : undefined;
}

/** The string literal starting exactly at `offset`. */
export function stringAt(file: NixFile, offset: number): NixString | undefined {
  let low = 0;
  let high = file.strings.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = file.strings[mid];
    if (!candidate) break;
    if (candidate.start === offset) return candidate;
    if (candidate.start < offset) low = mid + 1;
    else high = mid - 1;
  }
  return undefined;
}

/** The identifier starting exactly at `offset`. */
export function identAt(file: NixFile, offset: number): NixIdent | undefined {
  let low = 0;
  let high = file.idents.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = file.idents[mid];
    if (!candidate) break;
    if (candidate.offset === offset) return candidate;
    if (candidate.offset < offset) low = mid + 1;
    else high = mid - 1;
  }
  return undefined;
}

/**
 * Excludes recognizable nixpkgs source trees, not a user project with one similarly named file.
 */
export function lintableNixFiles(project: ProjectModel): NixFile[] {
  const roots: string[] = [];
  for (const file of project.nix.files) {
    const match = /^(.*?)pkgs\/top-level\/all-packages\.nix$/.exec(file.path);
    if (match) {
      const root = match[1] ?? "";
      if (["lib/default.nix", "pkgs/stdenv/generic/default.nix", "nixos/modules/module-list.nix"]
        .every((marker) => project.files.has(`${root}${marker}`))) roots.push(root);
    }
  }
  return project.nix.files.filter((file) => !roots.some((root) => file.path.startsWith(root)));
}

/** `validateOptions` helper for options that must be arrays of strings. */
export function validateStringLists(options: Record<string, unknown>, ...names: string[]): string[] {
  return names
    .filter((name) => name in options)
    .filter((name) => {
      const value = options[name];
      return !Array.isArray(value) || !value.every((item) => typeof item === "string");
    })
    .map((name) => `${name} must be an array of strings`);
}

/** Offset of the innermost unclosed `{`, `(` or `[` before `offset`, or -1 at top level. */
export function enclosingOpen(masked: string, offset: number): number {
  let depth = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    const char = masked[index];
    if (char === "}" || char === ")" || char === "]") depth += 1;
    else if (char === "{" || char === "(" || char === "[") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** Whether the `{` at `open` starts a function pattern (`{ a, b ? 1 }:` or `{ ... }@args:`). */
export function isLambdaPattern(masked: string, open: number): boolean {
  if (masked[open] !== "{") return false;
  const close = matchingClose(masked, open);
  if (close < 0) return false;
  const after = masked[skipSpace(masked, close + 1)];
  return after === ":" || after === "@";
}

/** Whether `offset` lies in the names of an `inherit ...;` statement (not inside its `(source)`). */
export function inInherit(masked: string, offset: number): boolean {
  let index = offset - 1;
  while (index >= 0) {
    const char = masked[index] ?? "";
    if (char === ")") {
      let depth = 0;
      while (index >= 0) {
        if (masked[index] === ")") depth += 1;
        else if (masked[index] === "(") {
          depth -= 1;
          if (depth === 0) break;
        }
        index -= 1;
      }
      if (index < 0) return false;
      index -= 1;
      continue;
    }
    if (";{}=:,([]".includes(char)) break;
    index -= 1;
  }
  // The scan stops at punctuation only, so a preceding keyword (`let inherit x;`) may be included.
  return /(?<![A-Za-z0-9_'.-])inherit(?![A-Za-z0-9_'-])/.test(masked.slice(index + 1, offset));
}

/**
 * Whether the identifier is used as a value: not a binding key (`x = ...`), function parameter
 * (`x: ...`), pattern field (`{ x, ... }:`), `args@` alias, or `inherit` name.
 */
export function isValueUse(file: NixFile, ident: NixIdent): boolean {
  const { masked } = file;
  const after = skipSpace(masked, ident.end);
  const next = masked[after];
  if (next === "=" && masked[after + 1] !== "=") return false;
  if (next === ":" || next === "@") return false;
  const open = enclosingOpen(masked, ident.offset);
  if (open >= 0 && isLambdaPattern(masked, open)) {
    const before = masked[previousNonSpace(masked, ident.offset)];
    if (before === "{" || before === ",") return false;
  }
  return !inInherit(masked, ident.offset);
}

/**
 * The argument the identifier is applied to, when it is called (`f "x"`, `f { ... }`, `f (...)`,
 * `f rec { ... }`). Returns undefined for non-value uses and when an operator or keyword follows.
 */
export function callArgument(file: NixFile, ident: NixIdent): NixArgument | undefined {
  if (!isValueUse(file, ident)) return undefined;
  const arg = argumentAfter(file, ident.end);
  if (!arg) return undefined;
  if (arg.kind !== "other") return arg;
  const text = file.masked.slice(arg.start, arg.end);
  if (text === "rec") {
    const next = argumentAfter(file, arg.end);
    return next?.kind === "attrs" ? next : undefined;
  }
  if (KEYWORDS.has(text) || OPERATOR.test(text)) return undefined;
  return arg;
}

/** Strips redundant parentheses: `((x))` yields the argument for `x`. */
export function unwrapParens(file: NixFile, arg: NixArgument): NixArgument {
  let current = arg;
  while (current.kind === "paren") {
    const inner = argumentAfter(file, current.start + 1);
    if (!inner || skipSpace(file.masked, inner.end) !== current.end - 1) return current;
    current = inner;
  }
  return current;
}

/**
 * The leading string literal of a string-valued argument: a literal (`"..."`) or a concatenation
 * that starts with one (`("https://..." + rev)`). A concatenation is reported as an interpolated
 * string whose value ends in `${…}`, so callers never mistake the prefix for the whole value.
 */
export function leadingString(file: NixFile, arg: NixArgument): NixString | undefined {
  const unwrapped = unwrapParens(file, arg);
  if (unwrapped.kind === "string") return stringAt(file, unwrapped.start);
  if (unwrapped.kind !== "paren") return undefined;
  const inner = argumentAfter(file, unwrapped.start + 1);
  if (inner?.kind !== "string") return undefined;
  if (file.masked[skipSpace(file.masked, inner.end)] !== "+") return undefined;
  const prefix = stringAt(file, inner.start);
  return prefix ? { ...prefix, value: `${prefix.value}\${…}`, interpolated: true } : undefined;
}

/**
 * Offset of the `{` of the attribute set passed as `arg`: `{ ... }`, `rec { ... }`, `({ ... })`, or
 * the fixed-point forms `(finalAttrs: { ... })` / `(self: rec { ... })`.
 */
export function attrsetOf(file: NixFile, arg: NixArgument): number | undefined {
  if (arg.kind === "attrs") return arg.start;
  if (arg.kind !== "paren") return undefined;
  const { masked } = file;
  const head = /^\(\s*(?:[A-Za-z_][A-Za-z0-9_'-]*\s*:\s*)?(?:rec\s+)?\{/.exec(masked.slice(arg.start, arg.end));
  if (!head) return undefined;
  const brace = arg.start + head[0].length - 1;
  const close = matchingClose(masked, brace);
  if (close < 0 || skipSpace(masked, close + 1) !== arg.end - 1) return undefined;
  return brace;
}

export interface InheritStatement {
  /** Masked source expression in parentheses (`builtins` for `inherit (builtins) x;`), if any. */
  source?: string;
  offset: number;
  names: { name: string; offset: number }[];
}

export function inheritStatements(file: NixFile): InheritStatement[] {
  const found: InheritStatement[] = [];
  for (const match of file.masked.matchAll(/(?<![A-Za-z0-9_'.-])inherit(?![A-Za-z0-9_'-])\s*(?:\(([^()]*)\))?([^;]*);/g)) {
    const names: { name: string; offset: number }[] = [];
    const list = match[2] ?? "";
    const listStart = match.index + match[0].length - 1 - list.length;
    for (const name of list.matchAll(NAME)) names.push({ name: name[0], offset: listStart + name.index });
    const source = match[1]?.trim();
    found.push({ ...(source !== undefined ? { source } : {}), offset: match.index, names });
  }
  return found;
}

/** Names brought into scope from `builtins` by `inherit (builtins) ...;`. */
export function inheritedFromBuiltins(file: NixFile): Set<string> {
  const names = new Set<string>();
  if (isShadowed(file, "builtins")) return names;
  for (const statement of inheritStatements(file)) {
    if (statement.source === "builtins") for (const { name } of statement.names) names.add(name);
  }
  return names;
}

/** Top-level attribute names of the attribute set at `open`, including `inherit`ed names. */
export function attrKeys(file: NixFile, open: number): Set<string> {
  const keys = new Set<string>();
  for (const binding of nixBindings(file, open)) {
    const first = binding.path[0];
    if (first) keys.add(first);
  }
  for (const statement of inheritStatements(file)) {
    if (enclosingOpen(file.masked, statement.offset) !== open) continue;
    for (const { name } of statement.names) keys.add(name);
  }
  return keys;
}

/** The top-level binding `name = ...;` of the attribute set at `open`. */
export function bindingNamed(file: NixFile, open: number, name: string): NixBinding | undefined {
  return nixBindings(file, open).find((binding) => binding.path.length === 1 && binding.path[0] === name);
}

/** Offsets of `word` as a whole word in code (also after a `.`, e.g. `tools.${system}.word`). */
export function wordOffsets(file: NixFile, word: string): number[] {
  const offsets: number[] = [];
  let index = file.masked.indexOf(word);
  while (index >= 0) {
    const before = file.masked[index - 1] ?? "";
    const after = file.masked[index + word.length] ?? "";
    if (!IDENT_CHAR.test(before) && !IDENT_CHAR.test(after)) offsets.push(index);
    index = file.masked.indexOf(word, index + word.length);
  }
  return offsets;
}

/**
 * Whether a global name such as `fetchTarball` may be rebound in this file (a binding key, function
 * parameter, pattern field, or `inherit (x) name;` from something other than `builtins`). Bare uses
 * are then ambiguous and rules should skip them.
 */
export function isShadowed(file: NixFile, name: string): boolean {
  for (const statement of inheritStatements(file)) {
    if (statement.source !== undefined && statement.source !== "builtins" && statement.names.some((entry) => entry.name === name)) {
      return true;
    }
  }
  return file.idents.some((ident) => ident.segments[0] === name && !inInherit(file.masked, ident.offset) && !isValueUse(file, ident));
}

/** Whether `offset` lies in a default value of a function pattern (`{ pkgs ? import <nixpkgs> { } }:`). */
export function inLambdaDefault(masked: string, offset: number): boolean {
  let open = enclosingOpen(masked, offset);
  while (open >= 0) {
    if (isLambdaPattern(masked, open)) return true;
    open = enclosingOpen(masked, open);
  }
  return false;
}

/** The key of the binding whose value starts at `offset` (`hash = <offset>`), if any. */
export function assignedKey(masked: string, offset: number): string | undefined {
  const equals = previousNonSpace(masked, offset);
  if (masked[equals] !== "=" || "=!<>".includes(masked[equals - 1] ?? "")) return undefined;
  return previousWord(masked, equals);
}

/**
 * Attribute path of the innermost attribute-set binding whose value contains `offset`
 * (`["overlays", "default"]` for a lambda in `overlays.default = final: prev: { ... };`).
 */
export function enclosingBindingPath(file: NixFile, offset: number): string[] | undefined {
  let open = enclosingOpen(file.masked, offset);
  while (open >= 0) {
    if (file.masked[open] === "{" && !isLambdaPattern(file.masked, open)) {
      let best: NixBinding | undefined;
      for (const binding of nixBindings(file, open)) {
        if (binding.valueStart <= offset && offset <= binding.valueEnd && (!best || binding.valueStart >= best.valueStart)) best = binding;
      }
      if (best) return best.path;
    }
    open = enclosingOpen(file.masked, open);
  }
  return undefined;
}

/** Whether masked source text is a bare relative or absolute path literal (`./.`, `../..`, `/srv/x`). */
export function isPathLiteral(text: string): boolean {
  return /^(?:\.{1,2}|~)?\/[A-Za-z0-9._+\-/]*$/.test(text) || /^\.{1,2}(?:\/\.{1,2})*\/?$/.test(text);
}

/** Index just past a leading `let ... in` (and any further ones) starting at `index`, skipping whitespace. */
export function skipLetIn(masked: string, index: number): number {
  let cursor = skipSpace(masked, index);
  while (/^let(?![A-Za-z0-9_'-])/.test(masked.slice(cursor, cursor + 4))) {
    let depth = 0;
    let lets = 1;
    let found = -1;
    for (let scan = cursor + 3; scan < masked.length; scan += 1) {
      const char = masked[scan] ?? "";
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if (char === "}" || char === ")" || char === "]") {
        if (depth === 0) return cursor;
        depth -= 1;
      } else if (depth === 0 && !IDENT_CHAR.test(masked[scan - 1] ?? "") && masked[scan - 1] !== ".") {
        if (masked.startsWith("in", scan) && !IDENT_CHAR.test(masked[scan + 2] ?? "")) {
          lets -= 1;
          if (lets === 0) {
            found = scan + 2;
            break;
          }
        } else if (masked.startsWith("let", scan) && !IDENT_CHAR.test(masked[scan + 3] ?? "")) lets += 1;
      }
    }
    if (found < 0) return cursor;
    cursor = skipSpace(masked, found);
  }
  return cursor;
}

/** The identifier at the first non-space position from `offset` (the head of an expression). */
export function headIdent(file: NixFile, offset: number): NixIdent | undefined {
  return identAt(file, skipSpace(file.masked, offset));
}

/** Whether the word at `offset` is the key of a binding (`word = ...`, not `==`). */
export function isBindingKey(masked: string, offset: number, length: number): boolean {
  const next = skipSpace(masked, offset + length);
  return masked[next] === "=" && masked[next + 1] !== "=";
}

/** Raw source of an argument, collapsed to one line and truncated for messages. */
export function snippet(file: NixFile, start: number, end: number, max = 60): string {
  const text = file.content.slice(start, end).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
