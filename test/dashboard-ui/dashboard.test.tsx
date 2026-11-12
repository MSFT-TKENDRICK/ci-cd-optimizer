// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { defaultLayout, layoutProgram, layoutSchema, parseResult, projectionSchema } from "../../ui/dashboard/src/contract";
import { DashboardView } from "../../ui/dashboard/src/dashboard";
import { McpDashboard, TOOL_NAME } from "../../ui/dashboard/src/mcp-app";

const bridge = vi.hoisted(() => ({
  app: {
    callServerTool: vi.fn(),
    getHostContext: () => ({ theme: "light" }),
    ontoolinput: undefined as undefined | ((input: { arguments: Record<string, unknown> }) => void),
    ontoolresult: undefined as undefined | ((result: unknown) => void),
    onhostcontextchanged: undefined as undefined | ((context: { theme: "light" | "dark" }) => void),
    onteardown: undefined as undefined | (() => Promise<object>),
  },
}));
vi.mock("@modelcontextprotocol/ext-apps/react", () => ({
  useApp: ({ onAppCreated }: { onAppCreated: (app: typeof bridge.app) => void }) => {
    onAppCreated(bridge.app);
    return { app: bridge.app, isConnected: true, error: null };
  },
}));

afterEach(cleanup);

const projection = {
  schema: "cicd-optimizer/dashboard-metrics-v1",
  provenance: { owner: "org", repo: "repo", workflowName: "CI", runId: 42, runAttempt: 1, headSha: "abc", event: "push", branch: null, conclusion: null, collectedAt: null },
  metrics: { queueInclusiveLatencyMs: null, executionElapsedMs: 2000, initialQueueMs: null, observedRunnerWorkMs: 2000, completeRunnerWorkMs: null, completeness: { jobInventory: false, runnerWork: false } },
  jobs: [{ id: 8, name: "Build", conclusion: null, startedAt: null, completedAt: null, needs: ["setup"], durationMs: 2000, queueMs: null, readyQueueMs: null, critical: null, slackMs: null, headroomMs: null, limitedBy: null, steps: [] }],
  attribution: { available: false, logCoverage: null, findings: [], gaps: [{ kind: "log-unavailable", detail: "No logs" }] },
  comparison: { sampleCount: 0, medianExecutionElapsedMs: null, medianInitialQueueMs: null, examined: 0, comparableRunIds: [], excluded: {}, currentProblem: null },
  reworkExposure: { failedAttempts: 0, failedAttemptRunnerWorkMs: 0, allFailedAttemptInventoriesComplete: true },
};

describe("dashboard layout and evidence", () => {
  it("accepts only bounded unique section identifiers, never executable layouts", () => {
    expect(layoutSchema.safeParse({ sections: ["jobs", "overview"] }).success).toBe(true);
    for (const invalid of [{ sections: ["jobs", "jobs"] }, { sections: [] }, { sections: ["<script>"] }, { sections: ["jobs"], html: "<script/>" }]) {
      expect(layoutSchema.safeParse(invalid).success).toBe(false);
    }
    const result = parseResult({ structuredContent: { metrics: projection, layout: { sections: ["<script>"] } } });
    expect(result.layout).toEqual(defaultLayout);
    expect(result.invalidLayout).toBe(true);
    expect(layoutProgram(result.layout)).not.toContain("<script>");
  });
  it("rejects malformed or failed evidence", () => {
    expect(() => parseResult({ isError: true })).toThrow();
    expect(() => parseResult({ structuredContent: { metrics: {} } })).toThrow();
  });
  it("renders through OpenUI in the requested order, preserves unknowns and scopes job actions", async () => {
    const request = vi.fn();
    render(<DashboardView data={projectionSchema.parse(projection)} layout={{ sections: ["jobs", "overview", "attribution", "comparison"] }} pages={null} scope={{}} request={request} busy={false} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Jobs and dependencies" })).toBeTruthy());
    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(["Jobs and dependencies", "Run overview", "Evidence and gaps", "Comparable history"]);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getByText(/Job inventory is incomplete/)).toBeTruthy();
    expect(screen.getByText("log-unavailable: No logs")).toBeTruthy();
    expect(screen.getByText(/Unknown interval/)).toBeTruthy();
    expect(screen.getByText("Depends on: setup")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View Build details" }));
    expect(request).toHaveBeenCalledWith({ jobId: 8, jobOffset: null, stepOffset: null, findingOffset: null, gapOffset: null, evidenceOffset: null });
  });
  it("uses initial tool input and result, host theme, and scoped refresh calls", async () => {
    bridge.app.callServerTool.mockReset().mockResolvedValue({ structuredContent: projection });
    render(<McpDashboard />);
    const { act } = await import("@testing-library/react");
    act(() => {
      bridge.app.ontoolinput?.({ arguments: { repo: "org/repo", runId: 42 } });
      bridge.app.ontoolresult?.({ structuredContent: projection });
      bridge.app.onhostcontextchanged?.({ theme: "dark" });
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    await screen.findByRole("button", { name: "View Build details" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(bridge.app.callServerTool).toHaveBeenLastCalledWith({
      name: TOOL_NAME, arguments: { repo: "org/repo", runId: 42, runAttempt: 1 },
    }));
    await waitFor(() => expect((screen.getByRole("button", { name: "View Build details" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "View Build details" }));
    await waitFor(() => expect(bridge.app.callServerTool).toHaveBeenCalledWith({
      name: TOOL_NAME, arguments: { repo: "org/repo", runId: 42, runAttempt: 1, jobId: 8 },
    }));
    await screen.findByRole("button", { name: "All jobs" });
    fireEvent.click(screen.getByRole("button", { name: "All jobs" }));
    await waitFor(() => expect(bridge.app.callServerTool).toHaveBeenLastCalledWith({
      name: TOOL_NAME, arguments: { repo: "org/repo", runId: 42, runAttempt: 1 },
    }));
  });
  it("renders timelines and measured evidence with accessible server pagination", async () => {
    const data = projectionSchema.parse({
      ...projection,
      jobs: [{
        ...projection.jobs[0], startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:02Z",
        stepsTotal: 2, nextStepOffset: 1,
        steps: [{ number: 1, name: "Install", conclusion: "success", durationMs: 1000, startedAt: null, completedAt: null }],
      }],
      comparison: { ...projection.comparison, comparableRunIds: [17], excluded: { rerun: 2 }, currentProblem: "rerun" },
      attribution: { ...projection.attribution, logCoverage: { jobs: 1, jobsWithLogs: 1, explainedMs: 1200, unexplainedMs: 800, observedMs: 2000 }, findings: [{
        id: "cache", category: "package-cache", scope: "multiple-jobs", jobName: "Build", summary: "Cache was unavailable", observedMs: 1000,
        elapsedSavingsBoundMs: 500, runnerSavingsBoundMs: 1000, recommendation: "Review caching", evidence: ["Cache miss"],
        evidenceTotal: 2, nextEvidenceOffset: 1,
      }] },
    });
    const request = vi.fn();
    const pages = { jobs: { offset: 0, total: 2, nextOffset: 1 }, findings: { offset: 0, total: 2, nextOffset: 1 }, gaps: { offset: 0, total: 2, nextOffset: 1 } };
    render(<DashboardView data={data} layout={{ sections: ["jobs", "overview", "attribution", "comparison"] }} pages={pages} scope={{}} request={request} busy={false} />);
    await screen.findByText(/Cache was unavailable/);
    expect(screen.getByText(/2026-01-01T00:00:00Z/)).toBeTruthy();
    expect(screen.getByText(/Elapsed savings upper bound/)).toBeTruthy();
    expect(screen.getByText("Recommendation: Review caching")).toBeTruthy();
    expect(screen.getByText("Evidence scope: Multiple jobs")).toBeTruthy();
    expect(screen.getByText(/Step-explained time: 1.2 s · Unexplained time: 0.8 s/)).toBeTruthy();
    expect(screen.getByText(/Ready queue: Unknown · Slack: Unknown · Headroom: Unknown/)).toBeTruthy();
    expect(screen.getByText(/Comparable run IDs: 17/)).toBeTruthy();
    expect(screen.getByText(/Exclusions: rerun: 2/)).toBeTruthy();
    expect(screen.getByText("abc")).toBeTruthy();
    expect(screen.getByText("Cache miss")).toBeTruthy();
    for (const [label, expected] of [
      ["Jobs server pages", { jobOffset: 1, jobId: null, stepOffset: null }],
      ["Build steps server pages", { jobId: 8, jobOffset: null, stepOffset: 1, findingOffset: null, gapOffset: null, evidenceOffset: null }],
      ["Findings server pages", { findingOffset: 1, evidenceOffset: null }],
      ["Finding details server pages", { evidenceOffset: 1 }],
      ["Gaps server pages", { gapOffset: 1 }],
    ] as const) {
      fireEvent.click(screen.getByRole("navigation", { name: label }).querySelectorAll("button")[1]!);
      expect(request).toHaveBeenLastCalledWith(expected);
    }
  });
  it("refuses a refreshed result for a different attempt", async () => {
    bridge.app.callServerTool.mockReset().mockResolvedValue({
      structuredContent: { ...projection, provenance: { ...projection.provenance, runAttempt: 2 } },
    });
    render(<McpDashboard />);
    const { act } = await import("@testing-library/react");
    act(() => {
      bridge.app.ontoolinput?.({ arguments: { repo: "org/repo", runId: 42 } });
      bridge.app.ontoolresult?.({ structuredContent: projection });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not match the pinned attempt/);
  });
});
