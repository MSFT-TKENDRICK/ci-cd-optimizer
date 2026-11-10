// `*` matches within a path segment, `**` across segments (a `**` + `/` prefix also matches zero segments), `?` one character.
export function matchesGlob(path: string, glob: string): boolean {
  // Dynamic programming avoids exponential regex backtracking on repository-controlled patterns.
  let matched = new Uint8Array(path.length + 1);
  matched[0] = 1;
  const dot = (char: string) => char !== "\n" && char !== "\r" && char !== "\u2028" && char !== "\u2029";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    const next = new Uint8Array(path.length + 1);
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        next.set(matched);
        let reachable = false;
        for (let offset = 0; offset < path.length; offset += 1) {
          reachable = (reachable || matched[offset] === 1) && dot(path[offset]!);
          if (reachable && path[offset] === "/") next[offset + 1] = 1;
        }
        index += 2;
      } else {
        next[0] = matched[0]!;
        for (let offset = 0; offset < path.length; offset += 1) {
          next[offset + 1] = matched[offset + 1] || (next[offset] && dot(path[offset]!) ? 1 : 0);
        }
        index += 1;
      }
    } else if (char === "*") {
      next[0] = matched[0]!;
      for (let offset = 0; offset < path.length; offset += 1) {
        next[offset + 1] = matched[offset + 1] || (next[offset] && path[offset] !== "/" ? 1 : 0);
      }
    } else {
      for (let offset = 0; offset < path.length; offset += 1) {
        if (matched[offset] && (char === "?" ? path[offset] !== "/" : path[offset] === char)) next[offset + 1] = 1;
      }
    }
    matched = next;
  }
  return matched[path.length] === 1;
}

/** Maps with at most `limit` promises in flight, preserving order. A failure stops queued work, not in-flight work. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next;
      next += 1;
      try { results[index] = await fn(items[index] as T); }
      catch (error) { stopped = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}