import type { ApiJob, WorkflowRunPayload } from "../../src/telemetry/snapshot.js";
import { TIMEOUT_ONLY } from "../service/api.js";
import { MISSING_TIMEOUT, WORKFLOW } from "./helpers.js";

const encode = (content: string) => Response.json({ content: Buffer.from(content).toString("base64"), encoding: "base64" });
export const COLLECTOR_RUN: WorkflowRunPayload = {
  id: 2000, workflow_id: 7, name: "CI", path: WORKFLOW, run_attempt: 1, head_sha: "abc", head_branch: "main",
  event: "push", status: "completed", conclusion: "success",
  created_at: "2026-11-01T00:00:00Z", run_started_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T01:00:00Z",
};

/** The uncollected 501st job changes the real run duration from one minute to one hour. */
export function cappedJobs(): ApiJob[] {
  return Array.from({ length: 501 }, (_, index) => ({
    id: index + 1, name: `test (${index})`, conclusion: "success", started_at: COLLECTOR_RUN.run_started_at!,
    completed_at: index === 500 ? COLLECTOR_RUN.updated_at : "2026-11-01T00:01:00Z",
  }));
}

/** Real reader/collector fixtures; only GitHub HTTP responses are substituted, never service results. */
export function remoteFixture(options: { files?: Record<string, string>; jobs?: ApiJob[]; total?: (page: number) => unknown; abortSettlement?: Promise<void> } = {}) {
  const files = Object.entries(options.files ?? { [WORKFLOW]: MISSING_TIMEOUT });
  const jobs = options.jobs ?? [];
  const state = {
    mode: "normal" as "normal" | "fail" | "malformed" | "stall",
    started: 0, active: 0, aborted: 0, maximumActive: 0,
    jobPages: [] as number[],
    paths: [] as string[],
  };
  let releaseFailure: (() => void) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    state.paths.push(path);
    if (path === "/user") return Response.json({ id: 1, type: "User" });
    if (path === "/repos/acme/widgets") return Response.json({ id: 42, full_name: "acme/widgets", permissions: { pull: true }, default_branch: "main" });
    if (path.includes("/contents/")) {
      return encode(path.endsWith("ci-cd-optimizer.yml") ? TIMEOUT_ONLY : (options.files?.[WORKFLOW] ?? MISSING_TIMEOUT));
    }
    if (path.includes("/commits/")) return Response.json({ sha: "abc", commit: { tree: { sha: "tree" } } });
    if (path.includes("/git/trees/")) return Response.json({
      tree: files.map(([path, content], index) => ({ path, type: "blob", sha: `blob-${index}`, size: Buffer.byteLength(content) })),
      truncated: false,
    });
    if (path.includes("/git/blobs/")) {
      const index = Number(path.split("-").at(-1));
      state.started += 1;
      state.active += 1;
      state.maximumActive = Math.max(state.maximumActive, state.active);
      if (state.active === 8) releaseFailure?.();
      try {
        if (state.mode === "normal") return encode(files[index]?.[1] ?? "");
        if ((state.mode === "fail" || state.mode === "malformed") && index === 0) {
          await new Promise<void>((resolve) => { releaseFailure = resolve; });
          if (state.mode === "malformed") return Response.json({ content: null, encoding: "base64" });
          return Response.json({ message: "Denied" }, { status: 403 });
        }
        await new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) { reject(new Error("Missing GitHub read cancellation signal")); return; }
          let cancelled = false;
          const abort = () => {
            if (cancelled) return;
            cancelled = true;
            signal.removeEventListener("abort", abort);
            state.aborted += 1;
            // Delayed settlement proves that aborting alone is not sufficient to release the operation.
            if (options.abortSettlement) void options.abortSettlement.then(() => reject(signal.reason));
            else setTimeout(() => reject(signal.reason), 20);
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        throw new Error("Unreachable");
      } finally { state.active -= 1; }
    }
    if (path.endsWith("/actions/runs/2000")) return Response.json(COLLECTOR_RUN);
    if (path.endsWith("/actions/runs/2000/attempts/1/jobs")) {
      const page = Number(url.searchParams.get("page"));
      state.jobPages.push(page);
      return Response.json({
        jobs: jobs.slice((page - 1) * 100, page * 100),
        total_count: options.total ? options.total(page) : jobs.length,
      });
    }
    if (path.endsWith("/actions/workflows/7/runs")) return Response.json({ workflow_runs: [] });
    return Response.json({}, { status: 404 });
  };
  return { state, fetcher };
}

export const fanoutFiles = () => Object.fromEntries(Array.from({ length: 16 }, (_, index) =>
  [`.github/workflows/f${String(index).padStart(2, "0")}.yml`, MISSING_TIMEOUT]));
