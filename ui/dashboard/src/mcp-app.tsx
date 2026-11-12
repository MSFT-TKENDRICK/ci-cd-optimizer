import { applyDocumentTheme, type App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useRef, useState } from "react";
import { parseResult, type Layout, type PageRequest, type Pages, type Projection } from "./contract";
import { DashboardView } from "./dashboard";

type Snapshot = { projection: Projection; layout: Layout; pages: Pages | null; invalidLayout: boolean };
type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;
export const TOOL_NAME = "dashboard_metrics";
function scopeFromArgs(args: Record<string, unknown> | null): PageRequest {
  const scope: PageRequest = {};
  for (const key of ["jobId", "jobOffset", "stepOffset", "findingOffset", "gapOffset", "evidenceOffset"] as const) {
    if (typeof args?.[key] === "number") scope[key] = args[key];
  }
  return scope;
}

export function McpDashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<PageRequest>({});
  const input = useRef<Record<string, unknown> | null>(null);
  const generation = useRef(0);
  const receive = (result: ToolResult) => {
    try {
      const parsed = parseResult(result);
      if (input.current) input.current = { ...input.current, runAttempt: parsed.projection.provenance.runAttempt };
      setSnapshot(parsed); setError(null);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not read dashboard data."); }
  };
  const { app, isConnected, error: connectionError } = useApp({
    appInfo: { name: "CI/CD Optimizer dashboard", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolinput = (params) => { input.current = params.arguments ?? null; };
      created.ontoolresult = (result) => { generation.current++; setBusy(false); setScope(scopeFromArgs(input.current)); receive(result); };
      created.onhostcontextchanged = (context) => { if (context.theme) applyDocumentTheme(context.theme); };
      created.onteardown = async () => { generation.current++; input.current = null; setBusy(false); setSnapshot(null); return {}; };
    },
  });
  useEffect(() => {
    const theme = app?.getHostContext()?.theme;
    if (isConnected && theme) applyDocumentTheme(theme);
  }, [app, isConnected]);

  async function load(patch: PageRequest = {}) {
    if (!app || !input.current) { setError("Original tool scope is unavailable; refresh and drilldown are disabled."); return; }
    const current = ++generation.current;
    setBusy(true);
    try {
      const args = { ...input.current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete args[key];
        else args[key] = value;
      }
      const result = await app.callServerTool({ name: TOOL_NAME, arguments: args });
      if (current !== generation.current) return;
      const parsed = parseResult(result);
      if (parsed.projection.provenance.runAttempt !== args.runAttempt) throw new Error("The returned run attempt does not match the pinned attempt.");
      input.current = args;
      setSnapshot(parsed); setScope(scopeFromArgs(args)); setError(null);
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : "Could not load dashboard data.");
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <main>
    <header><div><p className="eyebrow">CI/CD Optimizer</p><h1>Workflow dashboard</h1>
      {snapshot && <p>{snapshot.projection.provenance.owner}/{snapshot.projection.provenance.repo} · {snapshot.projection.provenance.workflowName} · Run {snapshot.projection.provenance.runId}, attempt {snapshot.projection.provenance.runAttempt}</p>}
    </div><div className="actions"><button disabled={!isConnected || busy || !input.current} onClick={() => void load()}>Refresh</button>
      {scope.jobId != null && <button disabled={busy} onClick={() => void load({ jobId: null, jobOffset: null, stepOffset: null, findingOffset: null, gapOffset: null, evidenceOffset: null })}>All jobs</button>}</div></header>
    {connectionError && <p role="alert">Could not connect to the host: {connectionError.message}</p>}
    {error && <p role="alert">{error}</p>}
    {!connectionError && !snapshot && <p role="status">{isConnected ? "Waiting for dashboard evidence…" : "Connecting to the host…"}</p>}
    {snapshot && <>{scope.jobId != null && <p>Scoped to job {scope.jobId}; findings and gaps are filtered to that job.</p>}
      {snapshot.invalidLayout && <p role="status">Invalid layout supplied; showing the default layout.</p>}
      {busy && <p role="status">Loading dashboard evidence…</p>}
      <DashboardView data={snapshot.projection} layout={snapshot.layout} pages={snapshot.pages} scope={scope} request={(patch) => void load(patch)} busy={busy || !input.current} />
    </>}
  </main>;
}
