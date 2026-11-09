/**
 * A deliberately small, lossless scanner for the Nix expression language.
 *
 * It does not evaluate or fully parse Nix. It masks comments and literal string text (keeping
 * newlines and offsets intact, and keeping `${ ... }` interpolation code visible), records every
 * string literal, and offers bracket-aware helpers to read attribute-set bindings. That is enough
 * to answer the structural questions lint rules ask ("does this `fetchTarball` call pass a hash?",
 * "which inputs does this flake declare?") without false positives from comments or strings.
 */

export interface NixString {
  /** Offset of the opening delimiter. */
  start: number;
  /** Offset just past the closing delimiter. */
  end: number;
  /** Raw text between the delimiters (escapes and interpolations are not processed). */
  value: string;
  interpolated: boolean;
  indented: boolean;
  line: number;
}

export interface NixIdent {
  /** A dotted identifier such as `builtins.fetchTarball` or `pkgs.dockerTools.buildImage`. */
  text: string;
  segments: string[];
  offset: number;
  end: number;
  line: number;
}

export interface NixFile {
  path: string;
  dir: string;
  content: string;
  /** `content` with comments and literal string text replaced by spaces (newlines kept). */
  masked: string;
  strings: NixString[];
  idents: NixIdent[];
  lineOf(offset: number): number;
}

export interface NixBinding {
  /** Flattened attribute path, e.g. `["inputs", "nixpkgs", "url"]`. Dynamic segments are `${}`. */
  path: string[];
  line: number;
  keyStart: number;
  valueStart: number;
  /** Offset of the terminating `;` (or of the enclosing `}` when the `;` is missing). */
  valueEnd: number;
}

export interface NixSearchPath {
  /** Name inside the angle brackets, e.g. `nixpkgs` or `nixpkgs/lib`. */
  name: string;
  offset: number;
  line: number;
}

export interface NixArgument {
  kind: "attrs" | "string" | "paren" | "list" | "other";
  start: number;
  end: number;
}

export interface FlakeRef {
  type: "github" | "gitlab" | "sourcehut" | "git" | "path" | "tarball" | "file" | "indirect" | "other";
  owner?: string;
  repo?: string;
  ref?: string;
  rev?: string;
  host?: string;
  dir?: string;
  id?: string;
}

export interface FlakeInput {
  name: string;
  line: number;
  url?: string;
  urlLine?: number;
  flakeRef?: FlakeRef;
  /** `flake = false;` marks a non-flake source input. */
  flake?: boolean;
  follows?: string;
  /** `inputs.<name>.inputs.<sub>.follows = "...";` */
  nestedFollows: Map<string, string>;
  /** Attribute-style references (`type`, `owner`, `repo`, `ref`, `rev`, `dir`, `host`, `url`). */
  attrs: Map<string, string>;
}

export interface FlakeOutputs {
  line: number;
  /** Named arguments of the `outputs` function pattern. Empty for `outputs = inputs: ...`. */
  args: string[];
  /** True when the pattern contains `...` or the function takes a single bound argument. */
  open: boolean;
}

export interface FlakeConfigEntry {
  line: number;
  values: string[];
  raw: string;
}

export interface FlakeInfo {
  description?: string;
  inputs: Map<string, FlakeInput>;
  nixConfig: Map<string, FlakeConfigEntry>;
  outputs?: FlakeOutputs;
}

export interface FlakeLockNode {
  name: string;
  line: number;
  locked?: Record<string, unknown>;
  original?: Record<string, unknown>;
  inputs: Record<string, string | string[]>;
  flake?: boolean;
}

export interface FlakeLock {
  path: string;
  dir: string;
  version?: number;
  root: string;
  nodes: Map<string, FlakeLockNode>;
  /** Inputs of the root node, i.e. the flake's direct inputs. */
  rootInputs: Record<string, string | string[]>;
}

const IDENT_CHAR = /[A-Za-z0-9_'-]/;
const WORD_START = /[A-Za-z_]/;

export function isNixPath(path: string): boolean {
  return /\.nix$/i.test(path);
}

export function isFlakeLockPath(path: string): boolean {
  return (path.split("/").pop() ?? path) === "flake.lock";
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function lineStartsOf(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineLookup(content: string): (offset: number) => number {
  const starts = lineStartsOf(content);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** Masks comments and literal string text, and records every string literal (including nested ones). */
export function lexNix(content: string): { masked: string; strings: Omit<NixString, "line">[] } {
  const out = content.split("");
  const strings: Omit<NixString, "line">[] = [];
  const length = content.length;
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== "\n" && out[index] !== "\r") out[index] = " ";
    }
  };

  const code = (start: number, nested: boolean): number => {
    let index = start;
    let depth = 0;
    while (index < length) {
      const char = content[index];
      if (char === "#") {
        const newline = content.indexOf("\n", index);
        const end = newline < 0 ? length : newline;
        blank(index, end);
        index = end;
        continue;
      }
      if (char === "/" && content[index + 1] === "*") {
        const close = content.indexOf("*/", index + 2);
        const end = close < 0 ? length : close + 2;
        blank(index, end);
        index = end;
        continue;
      }
      if (char === '"') {
        index = doubleQuoted(index);
        continue;
      }
      if (char === "'" && content[index + 1] === "'" && !(index > 0 && IDENT_CHAR.test(content[index - 1] ?? ""))) {
        index = indented(index);
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        if (nested && depth === 0) return index + 1;
        depth -= 1;
      }
      index += 1;
    }
    return length;
  };

  const doubleQuoted = (start: number): number => {
    let index = start + 1;
    let literalStart = index;
    let interpolated = false;
    while (index < length) {
      const char = content[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "$" && content[index + 1] === "$") {
        index += 2;
        continue;
      }
      if (char === "$" && content[index + 1] === "{") {
        blank(literalStart, index);
        interpolated = true;
        index = code(index + 2, true);
        literalStart = index;
        continue;
      }
      if (char === '"') {
        blank(literalStart, index);
        strings.push({ start, end: index + 1, value: content.slice(start + 1, index), interpolated, indented: false });
        return index + 1;
      }
      index += 1;
    }
    blank(literalStart, length);
    strings.push({ start, end: length, value: content.slice(start + 1), interpolated, indented: false });
    return length;
  };

  const indented = (start: number): number => {
    let index = start + 2;
    let literalStart = index;
    let interpolated = false;
    while (index < length) {
      if (content.startsWith("'''", index) || content.startsWith("''$", index)) {
        index += 3;
        continue;
      }
      if (content.startsWith("''\\", index)) {
        index += 4;
        continue;
      }
      if (content.startsWith("''", index)) {
        blank(literalStart, index);
        strings.push({ start, end: index + 2, value: content.slice(start + 2, index), interpolated, indented: true });
        return index + 2;
      }
      if (content[index] === "$" && content[index + 1] === "$") {
        index += 2;
        continue;
      }
      if (content[index] === "$" && content[index + 1] === "{") {
        blank(literalStart, index);
        interpolated = true;
        index = code(index + 2, true);
        literalStart = index;
        continue;
      }
      index += 1;
    }
    blank(literalStart, length);
    strings.push({ start, end: length, value: content.slice(start + 2), interpolated, indented: true });
    return length;
  };

  code(0, false);
  strings.sort((a, b) => a.start - b.start);
  return { masked: out.join(""), strings };
}

export function parseNix(path: string, content: string): NixFile {
  const { masked, strings } = lexNix(content);
  const lineOf = lineLookup(content);
  const idents: NixIdent[] = [];
  const pattern = /[A-Za-z_][A-Za-z0-9_'-]*(?:\.[A-Za-z_][A-Za-z0-9_'-]*)*/g;
  for (const match of masked.matchAll(pattern)) {
    const offset = match.index;
    const text = match[0];
    const before = masked[offset - 1] ?? "";
    const after = masked[offset + text.length] ?? "";
    if (before === "/" || before === "." || before === "<" || IDENT_CHAR.test(before)) continue;
    if (after === "/" || after === ">") continue;
    idents.push({ text, segments: text.split("."), offset, end: offset + text.length, line: lineOf(offset) });
  }
  return {
    path,
    dir: dirOf(path),
    content,
    masked,
    strings: strings.map((string) => ({ ...string, line: lineOf(string.start) })),
    idents,
    lineOf,
  };
}

/** Index of the bracket closing the one at `open` (any of `{([`), or -1. Works on masked text. */
export function matchingClose(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function wordAt(masked: string, index: number): string | undefined {
  if (!WORD_START.test(masked[index] ?? "") || IDENT_CHAR.test(masked[index - 1] ?? "")) return undefined;
  const match = /[A-Za-z_][A-Za-z0-9_'-]*/y;
  match.lastIndex = index;
  return match.exec(masked)?.[0];
}

/**
 * Offset of the `;` that ends the expression starting at `start`, honouring brackets and the
 * `let ... in`, `with x;` and `assert x;` forms. Returns the offset of an unmatched closing bracket
 * (or the end of the text) when no terminator is found.
 */
export function exprEnd(masked: string, start: number): number {
  let depth = 0;
  let lets = 0;
  let pendingSemicolons = 0;
  let index = start;
  while (index < masked.length) {
    const char = masked[index] ?? "";
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && char === ";") {
      if (pendingSemicolons > 0) pendingSemicolons -= 1;
      else if (lets === 0) return index;
    } else if (depth === 0) {
      const word = wordAt(masked, index);
      if (word) {
        if (word === "let") lets += 1;
        else if (word === "in" && lets > 0) lets -= 1;
        else if (word === "with" || word === "assert") pendingSemicolons += 1;
        index += word.length;
        continue;
      }
    }
    index += 1;
  }
  return masked.length;
}

function skipSpace(masked: string, index: number): number {
  let cursor = index;
  while (cursor < masked.length && /\s/.test(masked[cursor] ?? "")) cursor += 1;
  return cursor;
}

function stringAt(file: NixFile, offset: number): NixString | undefined {
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

/** The expression immediately following `end` (typically the argument of a function call). */
export function argumentAfter(file: NixFile, end: number): NixArgument | undefined {
  const start = skipSpace(file.masked, end);
  const char = file.masked[start];
  if (char === undefined) return undefined;
  if (char === "{" || char === "(" || char === "[") {
    const close = matchingClose(file.masked, start);
    if (close < 0) return undefined;
    return { kind: char === "{" ? "attrs" : char === "(" ? "paren" : "list", start, end: close + 1 };
  }
  const string = stringAt(file, start);
  if (string) return { kind: "string", start, end: string.end };
  if (char === ";" || char === "}" || char === ")" || char === "]" || char === ",") return undefined;
  let cursor = start;
  while (cursor < file.masked.length && !/[\s;,)}\]]/.test(file.masked[cursor] ?? "")) cursor += 1;
  return { kind: "other", start, end: cursor };
}

function readAttrPath(file: NixFile, start: number): { segments: string[]; end: number } | undefined {
  const { masked } = file;
  const segments: string[] = [];
  let index = start;
  for (;;) {
    index = skipSpace(masked, index);
    const char = masked[index] ?? "";
    if (char === '"') {
      const string = stringAt(file, index);
      if (!string) return undefined;
      segments.push(string.interpolated ? "${}" : string.value);
      index = string.end;
    } else if (char === "$" && masked[index + 1] === "{") {
      const close = matchingClose(masked, index + 1);
      if (close < 0) return undefined;
      segments.push("${}");
      index = close + 1;
    } else {
      const word = /[A-Za-z_][A-Za-z0-9_'-]*/y;
      word.lastIndex = index;
      const match = word.exec(masked);
      if (!match) return undefined;
      segments.push(match[0]);
      index += match[0].length;
    }
    const next = skipSpace(masked, index);
    if (masked[next] === ".") {
      index = next + 1;
      continue;
    }
    return { segments, end: next };
  }
}

/**
 * Bindings of the attribute set whose `{` is at `open`, flattened through nested attribute sets
 * (`inputs = { nixpkgs.url = ...; }` yields `["inputs", "nixpkgs", "url"]`). Parent bindings are
 * kept too. Returns an empty list for function patterns such as `{ pkgs, lib, ... }:`.
 */
export function nixBindings(file: NixFile, open: number, prefix: string[] = []): NixBinding[] {
  const { masked } = file;
  const close = matchingClose(masked, open);
  if (close < 0) return [];
  const bindings: NixBinding[] = [];
  let index = open + 1;
  while (index < close) {
    index = skipSpace(masked, index);
    if (index >= close) break;
    const word = wordAt(masked, index);
    if (word === "inherit") {
      index = exprEnd(masked, index) + 1;
      continue;
    }
    const keyStart = index;
    const attrPath = readAttrPath(file, index);
    if (!attrPath || masked[attrPath.end] !== "=" || masked[attrPath.end + 1] === "=") break;
    const valueStart = skipSpace(masked, attrPath.end + 1);
    const valueEnd = Math.min(exprEnd(masked, valueStart), close);
    const path = [...prefix, ...attrPath.segments];
    bindings.push({ path, line: file.lineOf(keyStart), keyStart, valueStart, valueEnd });
    const nested = /^(?:rec\s+)?\{/.exec(masked.slice(valueStart, valueStart + 8));
    if (nested) {
      const brace = valueStart + nested[0].length - 1;
      const nestedClose = matchingClose(masked, brace);
      if (nestedClose >= 0 && masked.slice(nestedClose + 1, valueEnd).trim() === "") {
        bindings.push(...nixBindings(file, brace, path));
      }
    }
    index = valueEnd + 1;
  }
  return bindings;
}

/** Offset of the `{` of a file whose whole body is an attribute set (as in `flake.nix`). */
export function topLevelAttrset(file: NixFile): number | undefined {
  const open = skipSpace(file.masked, 0);
  if (file.masked[open] !== "{") return undefined;
  const close = matchingClose(file.masked, open);
  if (close < 0) return undefined;
  const after = skipSpace(file.masked, close + 1);
  if (file.masked[after] === ":" || file.masked[after] === "@") return undefined;
  return open;
}

/** The value of a binding when it is exactly one non-interpolated string literal. */
export function bindingString(file: NixFile, binding: NixBinding): string | undefined {
  const string = stringAt(file, binding.valueStart);
  if (!string || string.interpolated) return undefined;
  if (file.masked.slice(string.end, binding.valueEnd).trim() !== "") return undefined;
  return string.value;
}

/** Raw (unmasked) source text of a binding's value, trimmed. */
export function bindingText(file: NixFile, binding: NixBinding): string {
  return file.content.slice(binding.valueStart, binding.valueEnd).trim();
}

export function stringsIn(file: NixFile, start: number, end: number): NixString[] {
  return file.strings.filter((string) => string.start >= start && string.end <= end);
}

/** `<nixpkgs>`-style lookup paths, which resolve through the machine-local `NIX_PATH`. */
export function searchPaths(file: NixFile): NixSearchPath[] {
  const found: NixSearchPath[] = [];
  for (const match of file.masked.matchAll(/<([A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*)>/g)) {
    found.push({ name: match[1] ?? "", offset: match.index, line: file.lineOf(match.index) });
  }
  return found;
}

/** Identifiers equal to one of `names` (e.g. `builtins.fetchTarball`, `fetchTarball`). */
export function identsNamed(file: NixFile, ...names: string[]): NixIdent[] {
  const wanted = new Set(names);
  return file.idents.filter((ident) => wanted.has(ident.text));
}

/** Identifiers whose last segment is `name` (e.g. `buildImage` matches `pkgs.dockerTools.buildImage`). */
export function identsEndingWith(file: NixFile, name: string): NixIdent[] {
  return file.idents.filter((ident) => ident.segments.at(-1) === name);
}

function queryParams(text: string): { base: string; params: Map<string, string> } {
  const question = text.indexOf("?");
  if (question < 0) return { base: text, params: new Map() };
  const params = new Map<string, string>();
  for (const pair of text.slice(question + 1).split("&")) {
    const [key, value = ""] = pair.split("=");
    if (key) params.set(key, decodeURIComponent(value));
  }
  return { base: text.slice(0, question), params };
}

const HEX40 = /^[0-9a-f]{40}$/i;

/** Parses a flake reference URL such as `github:NixOS/nixpkgs/nixos-24.11` or `git+https://...`. */
export function parseFlakeRef(url: string): FlakeRef {
  const { base, params } = queryParams(url.trim());
  const extra: Pick<FlakeRef, "ref" | "rev" | "dir" | "host"> = {};
  for (const key of ["ref", "rev", "dir", "host"] as const) {
    const value = params.get(key);
    if (value) extra[key] = value;
  }
  const refOrRevOf = (value: string | undefined): Pick<FlakeRef, "ref" | "rev"> =>
    value ? (HEX40.test(value) ? { rev: value } : { ref: value }) : {};
  const forge = /^(github|gitlab|sourcehut):([^/]+)\/([^/]+)(?:\/(.+))?$/.exec(base);
  if (forge?.[1] && forge[2] && forge[3]) {
    return {
      type: forge[1] as "github" | "gitlab" | "sourcehut",
      owner: forge[2],
      repo: forge[3],
      ...refOrRevOf(forge[4]),
      ...extra,
    };
  }
  if (/^git\+/.test(base)) {
    const host = /^git\+[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)/.exec(base)?.[1];
    return { type: "git", ...(host ? { host } : {}), ...extra };
  }
  if (/^(path:|\.{1,2}(\/|$)|\/)/.test(base)) return { type: "path", ...extra };
  if (/^file\+/.test(base) || /^file:\/\//.test(base)) return { type: "file", ...extra };
  if (/^(tarball\+)?https?:\/\//.test(base)) {
    const host = /^(?:tarball\+)?https?:\/\/([^/:]+)/.exec(base)?.[1];
    return { type: "tarball", ...(host ? { host } : {}), ...extra };
  }
  const indirect = /^(?:flake:)?([A-Za-z][A-Za-z0-9_-]*)(?:\/(.+))?$/.exec(base);
  if (indirect?.[1] && (base.startsWith("flake:") || !base.includes(":"))) {
    return { type: "indirect", id: indirect[1], ...refOrRevOf(indirect[2]), ...extra };
  }
  return { type: "other", ...extra };
}

function functionPatternArgs(file: NixFile, valueStart: number, valueEnd: number): FlakeOutputs | undefined {
  const { masked } = file;
  const line = file.lineOf(valueStart);
  const bound = /^([A-Za-z_][A-Za-z0-9_'-]*)\s*(@\s*)?/.exec(masked.slice(valueStart, valueEnd));
  let cursor = valueStart;
  if (bound) {
    const after = skipSpace(masked, valueStart + (bound[1]?.length ?? 0));
    if (masked[after] === ":") return { line, args: [], open: true };
    if (masked[after] !== "@") return undefined;
    cursor = skipSpace(masked, after + 1);
  }
  if (masked[cursor] !== "{") return undefined;
  const close = matchingClose(masked, cursor);
  if (close < 0) return undefined;
  let after = skipSpace(masked, close + 1);
  let open = Boolean(bound?.[2]);
  if (masked[after] === "@") {
    open = true;
    after = skipSpace(masked, after + 1);
    const name = /[A-Za-z_][A-Za-z0-9_'-]*/y;
    name.lastIndex = after;
    const match = name.exec(masked);
    if (match) after = skipSpace(masked, after + match[0].length);
  }
  if (masked[after] !== ":") return undefined;
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of masked.slice(cursor + 1, close)) {
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current);
      current = "";
    } else current += char;
  }
  args.push(current);
  const names: string[] = [];
  for (const arg of args) {
    const trimmed = arg.trim();
    if (trimmed === "...") open = true;
    const name = /^([A-Za-z_][A-Za-z0-9_'-]*)/.exec(trimmed)?.[1];
    if (name) names.push(name);
  }
  return { line, args: names, open };
}

/** Structural summary of a `flake.nix`. */
export function flakeInfo(file: NixFile): FlakeInfo | undefined {
  const open = topLevelAttrset(file);
  if (open === undefined) return undefined;
  const bindings = nixBindings(file, open);
  const inputs = new Map<string, FlakeInput>();
  const nixConfig = new Map<string, FlakeConfigEntry>();
  let description: string | undefined;
  let outputs: FlakeOutputs | undefined;
  const inputFor = (name: string, line: number): FlakeInput => {
    let input = inputs.get(name);
    if (!input) {
      input = { name, line, nestedFollows: new Map(), attrs: new Map() };
      inputs.set(name, input);
    }
    return input;
  };
  for (const binding of bindings) {
    const [head, name, field, sub, subField] = binding.path;
    if (binding.path.length === 1 && head === "description") description = bindingString(file, binding);
    if (binding.path.length === 1 && head === "outputs") {
      outputs = functionPatternArgs(file, binding.valueStart, binding.valueEnd) ?? outputs;
    }
    if (head === "nixConfig" && name && binding.path.length === 2) {
      const values = stringsIn(file, binding.valueStart, binding.valueEnd)
        .filter((string) => !string.interpolated)
        .map((string) => string.value);
      nixConfig.set(name, { line: binding.line, values, raw: bindingText(file, binding) });
    }
    if (head !== "inputs" || !name || name === "${}") continue;
    const input = inputFor(name, binding.line);
    if (binding.path.length === 2) {
      const shorthand = bindingString(file, binding);
      if (shorthand !== undefined) {
        input.url = shorthand;
        input.urlLine = binding.line;
      }
      continue;
    }
    const text = bindingText(file, binding);
    if (field === "url" && binding.path.length === 3) {
      const url = bindingString(file, binding);
      if (url !== undefined) {
        input.url = url;
        input.urlLine = binding.line;
      }
    } else if (field === "flake" && binding.path.length === 3) {
      if (text === "false") input.flake = false;
      else if (text === "true") input.flake = true;
    } else if (field === "follows" && binding.path.length === 3) {
      const follows = bindingString(file, binding);
      if (follows !== undefined) input.follows = follows;
    } else if (field === "inputs" && sub && subField === "follows" && binding.path.length === 5) {
      const follows = bindingString(file, binding);
      if (follows !== undefined) input.nestedFollows.set(sub, follows);
    } else if (field && binding.path.length === 3) {
      const value = bindingString(file, binding);
      if (value !== undefined) input.attrs.set(field, value);
    }
  }
  for (const input of inputs.values()) {
    if (input.url !== undefined) input.flakeRef = parseFlakeRef(input.url);
    else if (input.attrs.get("type")) {
      const type = input.attrs.get("type") ?? "";
      const owner = input.attrs.get("owner");
      const repo = input.attrs.get("repo");
      const ref = input.attrs.get("ref");
      const rev = input.attrs.get("rev");
      const id = input.attrs.get("id");
      input.flakeRef = {
        type: ["github", "gitlab", "sourcehut", "git", "path", "tarball", "file", "indirect"].includes(type)
          ? (type as FlakeRef["type"])
          : "other",
        ...(owner ? { owner } : {}),
        ...(repo ? { repo } : {}),
        ...(ref ? { ref } : {}),
        ...(rev ? { rev } : {}),
        ...(id ? { id } : {}),
      };
    }
  }
  return {
    ...(description !== undefined ? { description } : {}),
    inputs,
    nixConfig,
    ...(outputs ? { outputs } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function inputsRecord(value: unknown): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(record(value) ?? {})) {
    if (typeof entry === "string") result[key] = entry;
    else if (Array.isArray(entry)) result[key] = entry.map(String);
  }
  return result;
}

/** Parses a `flake.lock` (JSON). Throws on malformed JSON so callers can report a parse problem. */
export function parseFlakeLock(path: string, content: string): FlakeLock {
  const json = record(JSON.parse(content) as unknown) ?? {};
  const root = typeof json.root === "string" ? json.root : "root";
  const nodes = new Map<string, FlakeLockNode>();
  const lineOf = lineLookup(content);
  const nodesAt = Math.max(0, content.indexOf('"nodes"'));
  for (const [name, value] of Object.entries(record(json.nodes) ?? {})) {
    const node = record(value) ?? {};
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`"${escaped}"\\s*:\\s*\\{`, "g");
    match.lastIndex = nodesAt;
    const found = match.exec(content);
    const locked = record(node.locked);
    const original = record(node.original);
    nodes.set(name, {
      name,
      line: found ? lineOf(found.index) : 1,
      ...(locked ? { locked } : {}),
      ...(original ? { original } : {}),
      inputs: inputsRecord(node.inputs),
      ...(typeof node.flake === "boolean" ? { flake: node.flake } : {}),
    });
  }
  return {
    path,
    dir: dirOf(path),
    ...(typeof json.version === "number" ? { version: json.version } : {}),
    root,
    nodes,
    rootInputs: nodes.get(root)?.inputs ?? {},
  };
}

/** Resolves a lock input reference (a node name, or a `follows` path from the root) to its node. */
export function resolveLockInput(lock: FlakeLock, reference: string | string[]): FlakeLockNode | undefined {
  if (typeof reference === "string") return lock.nodes.get(reference);
  let node = lock.nodes.get(lock.root);
  for (const segment of reference) {
    const next = node?.inputs[segment];
    if (next === undefined) return undefined;
    node = resolveLockInput(lock, next);
  }
  return node;
}
