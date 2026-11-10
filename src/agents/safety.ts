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
  cleanupMs: 1_000,
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

interface OwnedWork {
  controller: AbortController;
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
  failed: boolean;
  failure?: unknown;
}

const ownedOperations = new WeakMap<AbortSignal, OwnedWork>();

/** Also used when a command handles its own error instead of rejecting its outer operation. */
export function failOwnedWork(signal: AbortSignal, error: unknown): void {
  const owned = ownedOperations.get(signal);
  if (!owned || owned.signal.aborted) return;
  owned.failed = true;
  owned.failure = error;
  owned.controller.abort(error);
}

/** Register before starting a read; a failed child stops queued reads and cancels its siblings. */
export function ownWork<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
  cancelSiblings: (error: unknown) => boolean = () => true,
): Promise<T> {
  const owned = ownedOperations.get(signal);
  if (!owned) return Promise.reject(new AgentError("Remote reads require an active operation."));
  const pending = Promise.resolve().then(() => {
    owned.signal.throwIfAborted();
    return run(owned.signal);
  });
  owned.pending.add(pending);
  return pending.then((value) => {
    owned.pending.delete(pending);
    return value;
  }, (error: unknown) => {
    owned.pending.delete(pending);
    if (cancelSiblings(error)) failOwnedWork(signal, error);
    throw owned.failed ? owned.failure : error;
  });
}

export async function operation<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs: number = LIMITS.operationMs,
  lifecycle: { onSettled?: () => void; cleanupMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const children = new AbortController();
  const owned: OwnedWork = {
    controller: children, signal: AbortSignal.any([controller.signal, children.signal]), pending: new Set(), failed: false,
  };
  ownedOperations.set(controller.signal, owned);
  const deadline = performance.now() + timeoutMs;
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new AgentError("Operation deadline exceeded.")), timeoutMs);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    if (performance.now() >= deadline) controller.abort(new AgentError("Operation deadline exceeded."));
    controller.signal.throwIfAborted();
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
    failOwnedWork(controller.signal, error);
  }
  controller.abort();
  // Even a handler that caught an error owns its unfinished reads. Retain capacity/session cancellation
  // until they settle; an uncooperative transport may delay cleanup, but cannot open another work slot.
  let settled = false;
  const drained = Promise.allSettled([...owned.pending]).then(() => {
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    ownedOperations.delete(controller.signal);
    lifecycle.onSettled?.();
  });
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drained,
    new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, lifecycle.cleanupMs ?? LIMITS.cleanupMs); }),
  ]);
  clearTimeout(cleanupTimer);
  if (!outcome.ok) throw outcome.error;
  if (!settled) throw owned.failed ? owned.failure : new AgentError("Operation cleanup is still pending; capacity remains reserved until its reads settle.");
  signal?.throwIfAborted();
  return outcome.value;
}
