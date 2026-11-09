/**
 * Escaping for untrusted text (target repository content, submitter YAML, API data) rendered into public Markdown
 * comments, job summaries, and logs. Every untrusted string must pass through `escapeInline` before rendering.
 */

const ZWSP = "\u200B";

/** Line and paragraph separators, including the C1 NEL, become spaces so a value can never start a new line. */
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]+/g;
/**
 * C0/C1 controls, bidi embeddings/overrides/isolates and marks (Trojan Source), zero-width characters, the BOM,
 * soft hyphens, and Unicode tag characters.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

export const MAX_INLINE_LENGTH = 300;
export const MAX_COMMENT_LENGTH = 60_000;

/** Removes invisible and control characters and collapses whitespace; does not escape Markdown. */
export function sanitizeText(value: unknown): string {
  return String(value)
    .replace(LINE_BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function truncate(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length > max ? `${characters.slice(0, Math.max(0, max - 1)).join("")}…` : value;
}

/** A short, quoted, single-line rendering of a value for problem messages (still escaped again when rendered). */
export function describeValue(value: unknown, max = 80): string {
  if (typeof value === "string") return JSON.stringify(truncate(sanitizeText(value), max));
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "a mapping" : typeof value;
}

/**
 * Makes an untrusted string safe to place in Markdown prose or a table cell (never inside a code span):
 * strips invisible/bidi/control characters, collapses newlines, caps the length, entity-encodes HTML, escapes
 * Markdown punctuation, and inserts a zero-width space to defuse @mentions, #references, GH- references, URLs
 * (`://`, `www.`), and workflow commands (`::`).
 */
export function escapeInline(value: unknown, max = MAX_INLINE_LENGTH): string {
  const text = truncate(sanitizeText(value), max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[@#\uFF20\uFF03]/g, (character) => `${character}${ZWSP}`)
    .replace(/:(?=[:/])/g, `:${ZWSP}`)
    .replace(/\b(www|gh)([.-])/gi, `$1${ZWSP}$2`);
  // Entities produced above keep their `&` and `;` so they still render as characters.
  return text.replace(/(&(?:amp|lt|gt);)|[\\`*_{}[\]()#+\-.!|~^=$"']/g, (match, entity: string | undefined) => entity ?? `\\${match}`);
}

/** Caps a rendered comment, cutting at a line boundary and keeping the leading marker line intact. */
export function capComment(body: string, max = MAX_COMMENT_LENGTH): string {
  if (body.length <= max) return body;
  const notice = "\n\n_Report truncated to fit the comment size limit. Run the review locally for the full report._\n";
  const room = max - notice.length;
  const cut = body.lastIndexOf("\n", room);
  return `${body.slice(0, cut > 0 ? cut : room)}${notice}`;
}
