import type { Diagnostic, Fix, SourceFile, TextEdit } from "./types.js";

/** Character offset of the start of a 1-based line. */
export function lineStart(content: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  return offset;
}

export function lineText(content: string, line: number): string {
  const start = lineStart(content, line);
  const end = content.indexOf("\n", start);
  return content.slice(start, end < 0 ? content.length : end).replace(/\r$/, "");
}

export function indentOf(content: string, line: number): string {
  return /^\s*/.exec(lineText(content, line))?.[0] ?? "";
}

function newline(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Replaces the first occurrence of `search` on a line. Returns undefined when the text is not on that line. */
export function replaceOnLine(
  file: SourceFile,
  line: number,
  search: string | RegExp,
  replacement: string,
): TextEdit | undefined {
  const start = lineStart(file.content, line);
  const text = lineText(file.content, line);
  const match = typeof search === "string" ? { index: text.indexOf(search), 0: search } : search.exec(text);
  if (!match || match.index < 0) return undefined;
  return { path: file.path, start: start + match.index, end: start + match.index + match[0].length, text: replacement };
}

/** Inserts whole lines after `line` (use 0 to insert at the top). Lines are written verbatim. */
export function insertLinesAfter(file: SourceFile, line: number, lines: string[]): TextEdit {
  const eol = newline(file.content);
  if (line <= 0) return { path: file.path, start: 0, end: 0, text: lines.map((entry) => entry + eol).join("") };
  const start = lineStart(file.content, line + 1);
  const atEnd = start >= file.content.length && !file.content.endsWith("\n");
  const text = (atEnd ? eol : "") + lines.map((entry) => entry + eol).join("");
  return { path: file.path, start, end: start, text };
}

export function fix(description: string, ...edits: Array<TextEdit | undefined>): Fix | undefined {
  const defined = edits.filter((edit): edit is TextEdit => edit !== undefined);
  return defined.length === edits.length && defined.length > 0 ? { description, edits: defined } : undefined;
}

export interface FixResult {
  files: Map<string, string>;
  applied: Diagnostic[];
  conflicts: Diagnostic[];
}

/**
 * Applies non-overlapping fixes. A diagnostic's edits are applied atomically; if any of them overlaps an
 * edit already accepted in this pass, the whole fix is deferred (ESLint semantics) and reported as a conflict.
 */
export function applyFixes(files: SourceFile[], diagnostics: Diagnostic[]): FixResult {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const accepted: TextEdit[] = [];
  const applied: Diagnostic[] = [];
  const conflicts: Diagnostic[] = [];
  const overlaps = (a: TextEdit, b: TextEdit) =>
    a.path === b.path && (a.start < b.end && b.start < a.end || (a.start === a.end && a.start === b.start));
  for (const diagnostic of diagnostics) {
    const edits = diagnostic.fix?.edits;
    if (!edits || edits.length === 0) continue;
    if (edits.some((edit) => !contents.has(edit.path) || accepted.some((other) => overlaps(edit, other)))) {
      conflicts.push(diagnostic);
      continue;
    }
    accepted.push(...edits);
    applied.push(diagnostic);
  }
  const byPath = new Map<string, TextEdit[]>();
  for (const edit of accepted) byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
  const output = new Map<string, string>();
  for (const [path, edits] of byPath) {
    let content = contents.get(path) ?? "";
    for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
      content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    }
    output.set(path, content);
  }
  return { files: output, applied, conflicts };
}
