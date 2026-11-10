export class AgentError extends Error {
  override name = "AgentError";
}

export const LIMITS = {
  requestBytes: 256 * 1024,
  outputBytes: 128 * 1024,
  configBytes: 64 * 1024,
  fileBytes: 256 * 1024,
  workspaceBytes: 4 * 1024 * 1024,
  files: 250,
  entries: 20_000,
  depth: 40,
  sessions: 8,
  operationMs: 30_000,
  httpMs: 10_000,
  githubResponseBytes: 2 * 1024 * 1024,
  githubTotalBytes: 16 * 1024 * 1024,
  githubRequests: 256,
  connections: 32,
  userConnections: 4,
  requests: 32,
  userRequests: 8,
  streams: 64,
  userStreams: 12,
  operations: 4,
  userOperations: 2,
  connectionMs: 10 * 60_000,
  bufferedBytes: 256 * 1024,
  outputStallMs: 5_000,
} as const;

// eslint-disable-next-line no-control-regex -- reject invisible control/bidi characters in rendered output
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeMarkdown(text: string, max = 30_000): { text: string; truncated: boolean; omittedCharacters: number } {
  const clean = text.replace(CONTROL, "");
  const omittedCharacters = Math.max(0, clean.length - max);
  return {
    text: omittedCharacters ? `${clean.slice(0, max)}\n\n… (${omittedCharacters} characters omitted)` : clean,
    truncated: omittedCharacters > 0,
    omittedCharacters,
  };
}

/** Escape repository-derived values, not the surrounding trusted Markdown layout. */
export function escapeMarkdown(value: string): string {
  return sanitizeMarkdown(value, 4096).text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&").replace(/\r?\n/g, " ");
}

export function inlineCode(value: string): string {
  const clean = sanitizeMarkdown(value, 4096).text.replace(/[\r\n]/g, " ");
  const fence = "`".repeat(Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  return `${fence}${clean.includes("`") || clean.startsWith(" ") || clean.endsWith(" ") ? ` ${clean} ` : clean}${fence}`;
}

export function codeBlock(value: string, language = "text"): string {
  const fence = "`".repeat(Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

/** Never return a partial JSON value or a partially executable fix when the final byte budget is exhausted. */
export function boundedResult(value: Record<string, unknown>, maxBytes: number = LIMITS.outputBytes): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= maxBytes) return value;
  return {
    error: "Result exceeded the output budget. Narrow the selected paths, query, or diagnostic limit. No partial fix is returned.",
    truncation: { truncated: true, omittedResponseBytes: bytes, maxBytes },
  };
}

/** Reject excess work rather than accumulating an unbounded waiting queue. Hold permits until work actually settles. */
export class WorkLimiter {
  private total = 0;
  private readonly users = new Map<string, number>();

  constructor(private readonly maximum: number, private readonly perUser: number) {}

  acquire(user = "local"): () => void {
    const count = this.users.get(user) ?? 0;
    if (this.total >= this.maximum || count >= this.perUser) throw new AgentError("Concurrency limit reached; retry after current work completes.");
    this.total += 1;
    this.users.set(user, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const remaining = (this.users.get(user) ?? 1) - 1;
      if (remaining) this.users.set(user, remaining);
      else this.users.delete(user);
    };
  }
}

export async function operation<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs: number = LIMITS.operationMs): Promise<T> {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new AgentError("Operation deadline exceeded.")), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    if (performance.now() >= deadline) controller.abort(new AgentError("Operation deadline exceeded."));
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
