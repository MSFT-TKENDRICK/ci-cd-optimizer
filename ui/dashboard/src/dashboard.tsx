import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createLibrary, defineComponent, Renderer } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { layoutProgram, sections, type Layout, type PageRequest, type Pages, type Projection } from "./contract";

type DashboardContext = { data: Projection; pages: Pages | null; request: (patch: PageRequest) => void; scope: PageRequest; busy: boolean };
const Context = createContext<DashboardContext | null>(null);
const duration = (value: number | null) => value === null ? "Unknown" : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
const text = (value: string | null) => value || "Unknown";
const PAGE_SIZE = 8;

function PageControls({ page, count, onPage, label }: { page: number; count: number; onPage: (page: number) => void; label: string }) {
  const pages = Math.ceil(count / PAGE_SIZE);
  if (pages <= 1) return null;
  return <nav className="pagination" aria-label={`${label} pages`}>
    <button disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
    <span>Page {page + 1} of {pages}</span>
    <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</button>
  </nav>;
}
function OffsetControls({ label, offset, total, next, busy, onOffset }: { label: string; offset: number; total: number; next: number | null; busy: boolean; onOffset: (offset: number) => void }) {
  const history = useRef<number[]>([]);
  useEffect(() => { if (offset === 0) history.current = []; }, [offset]);
  if (offset === 0 && next === null) return null;
  return <nav className="pagination" aria-label={`${label} server pages`}>
    <button disabled={busy || offset === 0} onClick={() => onOffset(history.current.pop() ?? 0)}>Previous</button>
    <span>Showing from {offset + 1} of {total}</span>
    <button disabled={busy || next === null} onClick={() => { if (next !== null) { history.current.push(offset); onOffset(next); } }}>Next</button>
  </nav>;
}

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function interval(start: string | null, end: string | null): [number, number] | null {
  const a = instant(start), b = instant(end);
  return a !== null && b !== null && b >= a ? [a, b] : null;
}

function Jobs({ data, pages, request, scope, busy }: DashboardContext) {
  const [jobPage, setJobPage] = useState(0);
  const [stepPage, setStepPage] = useState(0);
  const sortedJobs = [...data.jobs].sort((a, b) => (instant(a.startedAt) ?? Infinity) - (instant(b.startedAt) ?? Infinity));
  const safeJobPage = Math.min(jobPage, Math.max(0, Math.ceil(sortedJobs.length / PAGE_SIZE) - 1));
  const visibleJobs = sortedJobs.slice(safeJobPage * PAGE_SIZE, (safeJobPage + 1) * PAGE_SIZE);
  const intervals = sortedJobs.flatMap((job) => {
    const range = interval(job.startedAt, job.completedAt);
    return range ? [range] : [];
  });
  const earliest = intervals.length ? Math.min(...intervals.map(([start]) => start)) : 0;
  const latest = intervals.length ? Math.max(...intervals.map(([, end]) => end)) : 0;
  const span = Math.max(latest - earliest, 1);
  const maxWork = Math.max(1, ...sortedJobs.map((job) => job.durationMs ?? 0));
  const steps = sortedJobs.flatMap((job) => job.steps.map((step) => ({ ...step, jobId: job.id, jobName: job.name })))
    .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
  const maxStep = Math.max(1, ...steps.map((step) => step.durationMs ?? 0));
  const safeStepPage = Math.min(stepPage, Math.max(0, Math.ceil(steps.length / PAGE_SIZE) - 1));
  const visibleSteps = steps.slice(safeStepPage * PAGE_SIZE, (safeStepPage + 1) * PAGE_SIZE);
  return <section aria-labelledby="jobs"><h2 id="jobs">Jobs and dependencies</h2>
    {sortedJobs.length === 0 ? <p>No job evidence available.</p> : <>
      <h3>Chronological timeline</h3>
      <p className="muted">Bars show observed start and end times on a shared scale for the returned jobs. Dependencies are as reported, not inferred.</p>
      <ol className="timeline">
        {visibleJobs.map((job) => {
          const range = interval(job.startedAt, job.completedAt);
          return <li key={job.id} className="timeline-row">
            <div className="timeline-label"><strong>{job.name}</strong><span>Depends on: {job.needs.length ? job.needs.join(", ") : "None reported"}{job.omittedNeeds ? ` (${job.omittedNeeds} omitted)` : ""}</span>
              <span>{range ? `${job.startedAt} – ${job.completedAt}` : `Unknown interval (start: ${text(job.startedAt)}, end: ${text(job.completedAt)})`}</span></div>
            <div className="timeline-track" aria-hidden="true">{range && <span className="timeline-bar" style={{ left: `${(range[0] - earliest) / span * 100}%`, width: `${Math.max((range[1] - range[0]) / span * 100, 0.5)}%` }} />}</div>
            <button disabled={busy} onClick={() => request({ jobId: job.id, jobOffset: null, stepOffset: null, findingOffset: null, gapOffset: null, evidenceOffset: null })} aria-label={`View ${job.name} details`}>View</button>
          </li>;
        })}
      </ol>
      <PageControls page={safeJobPage} count={sortedJobs.length} onPage={setJobPage} label="Jobs" />
      <h3>Observed runner work by job</h3>
      <p className="muted">Job durations are runner work, not elapsed run time; concurrent jobs can overlap.</p>
      <ul className="bar-list">{visibleJobs.map((job) => <li key={job.id}>
        <div><strong>{job.name}</strong><span>{duration(job.durationMs)} · {text(job.conclusion)} · {job.critical === null ? "Critical path unknown" : job.critical ? "Critical path" : "Off critical path"}</span>
          <span>Ready queue: {duration(job.readyQueueMs)} · Slack: {duration(job.slackMs)} · Headroom: {duration(job.headroomMs)} · Limited by: {text(job.limitedBy)}</span></div>
        <div className="bar-track" aria-hidden="true">{job.durationMs !== null && <span style={{ width: `${job.durationMs / maxWork * 100}%` }} />}</div>
      </li>)}</ul>
      {!data.metrics.completeness.runnerWork && <p>Runner work is incomplete; comparisons cover observed jobs only.</p>}
      <h3>Slow steps by observed duration</h3>
      <p className="muted">Returned step durations, ordered longest first within this page. Missing or unreturned steps may hide slower work.</p>
      {steps.length === 0 ? <p>No step evidence available.</p> : <>
        <ul className="bar-list">{visibleSteps.map((step) => <li key={`${step.jobId}-${step.number}`}>
          <div><strong>{step.jobName} · {step.name}</strong><span>{duration(step.durationMs)} · {text(step.conclusion)}</span></div>
          <div className="bar-track" aria-hidden="true">{step.durationMs !== null && <span style={{ width: `${step.durationMs / maxStep * 100}%` }} />}</div>
        </li>)}</ul>
        <PageControls page={safeStepPage} count={steps.length} onPage={setStepPage} label="Steps" />
      </>}
      {visibleJobs.map((job) => job.stepsTotal !== undefined && <OffsetControls key={job.id} label={`${job.name} steps`}
        offset={scope.jobId === job.id ? scope.stepOffset ?? 0 : 0} total={job.stepsTotal} next={job.nextStepOffset ?? null} busy={busy}
        onOffset={(offset) => request({ jobId: job.id, jobOffset: null, stepOffset: offset, ...(scope.jobId !== job.id ? { findingOffset: null, gapOffset: null, evidenceOffset: null } : {}) })} />)}
    </>}
    {pages && <OffsetControls label="Jobs" {...pages.jobs} next={pages.jobs.nextOffset} busy={busy} onOffset={(offset) => request({ jobOffset: offset, jobId: null, stepOffset: null })} />}
  </section>;
}

function Attribution({ data, pages, scope, request, busy }: DashboardContext) {
  const [page, setPage] = useState(0);
  const findings = data.attribution.findings;
  const safePage = Math.min(page, Math.max(0, Math.ceil(findings.length / PAGE_SIZE) - 1));
  return <section aria-labelledby="attribution"><h2 id="attribution">Evidence and gaps</h2>
    <p>{data.attribution.logCoverage ? `Logs available for ${data.attribution.logCoverage.jobsWithLogs} of ${data.attribution.logCoverage.jobs} jobs.` : "Log coverage is unknown."}</p>
    <p>{data.attribution.logCoverage
      ? `Step-explained time: ${duration(data.attribution.logCoverage.explainedMs)} · Unexplained time: ${duration(data.attribution.logCoverage.unexplainedMs)} · Observed job time: ${duration(data.attribution.logCoverage.observedMs)}.`
      : "Step-explained and unexplained time are unknown."}</p>
    <p className="muted">Cache, install, container and other categories below reflect collected evidence only. Savings bounds are upper bounds, not predictions or guaranteed savings.</p>
    {findings.length ? <ul className="findings">{findings.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map((item) => <li key={item.id}>
      <strong>{item.category} · {item.jobName}</strong>{item.scope && <p>Evidence scope: {item.scope === "multiple-jobs" ? "Multiple jobs" : "Single job"}</p>}
      <p>{item.summary}</p><p>Recommendation: {item.recommendation || "Unknown"}</p>
      <p>Observed: {duration(item.observedMs)} · Elapsed savings upper bound: {duration(item.elapsedSavingsBoundMs)} · Runner savings upper bound: {duration(item.runnerSavingsBoundMs)}</p>
      {item.evidence.length > 0 ? <ul>{item.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <p>No supporting detail supplied.</p>}
    </li>)}</ul> : <p>No findings reported; this does not establish that no bottlenecks exist.</p>}
    <PageControls page={safePage} count={findings.length} onPage={setPage} label="Evidence" />
    {pages && <OffsetControls label="Findings" {...pages.findings} next={pages.findings.nextOffset} busy={busy} onOffset={(offset) => request({ findingOffset: offset, evidenceOffset: null })} />}
    {findings.some((finding) => finding.nextEvidenceOffset !== undefined || finding.evidenceTotal !== undefined) &&
      <OffsetControls label="Finding details" offset={scope.evidenceOffset ?? 0}
        total={Math.max(0, ...findings.map((finding) => finding.evidenceTotal ?? finding.evidence.length))}
        next={findings.reduce<number | null>((next, finding) => finding.nextEvidenceOffset == null ? next : Math.min(next ?? Infinity, finding.nextEvidenceOffset), null)}
        busy={busy} onOffset={(offset) => request({ evidenceOffset: offset })} />}
    {data.attribution.gaps.length > 0 && <><h3>Missing evidence</h3><ul>{data.attribution.gaps.map((gap, index) => <li key={index}>{gap.kind}: {gap.detail}</li>)}</ul></>}
    {pages && <OffsetControls label="Gaps" {...pages.gaps} next={pages.gaps.nextOffset} busy={busy} onOffset={(offset) => request({ gapOffset: offset })} />}
    <p>Failed-attempt runner work exposure: {duration(data.reworkExposure.failedAttemptRunnerWorkMs)} across {data.reworkExposure.failedAttempts} attempts; not a savings estimate{data.reworkExposure.allFailedAttemptInventoriesComplete ? "." : "; inventories are incomplete."}</p>
  </section>;
}

function Section({ name }: { name: Layout["sections"][number] }) {
  const context = useContext(Context);
  if (!context) return null;
  const { data } = context;
  if (name === "overview") return <section aria-labelledby="overview"><h2 id="overview">Run overview</h2>
    <div className="metrics">
      {([
        ["Queue-inclusive latency", data.metrics.queueInclusiveLatencyMs],
        ["Execution elapsed", data.metrics.executionElapsedMs],
        ["Initial queue", data.metrics.initialQueueMs],
        ["Complete runner work", data.metrics.completeRunnerWorkMs],
      ] as const).map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{duration(value)}</strong></div>)}
    </div>
    {!data.metrics.completeness.jobInventory && <p>Job inventory is incomplete. Observed runner work: {duration(data.metrics.observedRunnerWorkMs)}.</p>}
    <p>Conclusion: {text(data.provenance.conclusion)} · Branch: {text(data.provenance.branch)} · Event: {text(data.provenance.event)} · Commit: <code>{text(data.provenance.headSha)}</code> · Collected: {text(data.provenance.collectedAt)}</p>
  </section>;
  if (name === "jobs") return <Jobs {...context} />;
  if (name === "attribution") return <Attribution {...context} />;
  return <section aria-labelledby="comparison"><h2 id="comparison">Comparable history</h2>
    <p>{data.comparison.sampleCount} comparable runs from {data.comparison.examined} examined.</p>
    <p>Comparable run IDs: {data.comparison.comparableRunIds.length ? data.comparison.comparableRunIds.join(", ") : "None reported"}.</p>
    <p>Current comparison problem: {data.comparison.currentProblem ?? "None reported"}.</p>
    <p>Exclusions: {Object.entries(data.comparison.excluded).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "None reported"}.</p>
    <div className="metrics"><div className="metric"><span>Median execution</span><strong>{duration(data.comparison.medianExecutionElapsedMs)}</strong></div><div className="metric"><span>Median initial queue</span><strong>{duration(data.comparison.medianInitialQueueMs)}</strong></div></div>
    {data.comparison.sampleCount === 0 && <p>No comparable history available.</p>}
  </section>;
}

const Dashboard = defineComponent({
  name: "Dashboard",
  description: "A dashboard with a bounded list of named sections.",
  props: z.object({ sections: z.array(z.enum(sections)).min(1).max(4) }),
  component: ({ props }) => <>{props.sections.map((name) => <Section key={name} name={name} />)}</>,
});
export const dashboardLibrary = createLibrary({ components: [Dashboard], root: "Dashboard" });

export function DashboardView({ data, layout, pages, request, scope, busy }: DashboardContext & { layout: Layout }) {
  return <Context.Provider value={{ data, pages, request, scope, busy }}>
    <Renderer response={layoutProgram(layout)} library={dashboardLibrary} />
  </Context.Provider>;
}
