import type { RepoRef } from "../github/client.js";

/** Serializes repository operations within one App instance, not across processes or restarts. */
export class RepositoryQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(repo: RepoRef, work: () => Promise<T>): Promise<T> {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    const previous = this.tails.get(key);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    try {
      await previous;
      return await work();
    } finally {
      // The latch always resolves, but the caller still receives work's rejection.
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
