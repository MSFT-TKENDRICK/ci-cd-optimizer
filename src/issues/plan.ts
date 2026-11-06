export interface DesiredIssue {
  fingerprint: string;
  /** Content signature; an open issue is only rewritten when this changes (avoids churn from line shifts). */
  signature: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  assignCopilot: boolean;
  /** Higher first when `maxOpen` limits how many new issues can be opened. */
  priority: number;
}

export interface ExistingIssue {
  number: number;
  fingerprint: string;
  signature?: string;
  state: "open" | "closed";
  stateReason?: string | null;
  closedAt?: string | null;
  title: string;
  copilotPending?: boolean;
}

export type IssueAction =
  | { type: "create"; desired: DesiredIssue }
  | { type: "update"; number: number; desired: DesiredIssue; comment?: string; retryCopilot?: boolean }
  | { type: "reopen"; number: number; desired: DesiredIssue }
  | { type: "assign"; number: number; desired: DesiredIssue }
  | { type: "close"; number: number; fingerprint: string; comment: string };

export interface SkippedIssue {
  fingerprint: string;
  reason: "dismissed" | "limit";
  number?: number;
}

export interface IssueSyncPlan {
  actions: IssueAction[];
  skipped: SkippedIssue[];
}

export interface IssueSyncOptions {
  maxOpen: number;
  closeResolved: boolean;
  resolvedComment?: string;
}

/**
 * Pure reconciliation of managed issues against the current findings (Dependabot-alert semantics):
 * - open + still present: update only when the signature changed;
 * - closed as "not planned": treated as a dismissal and never reopened automatically;
 * - closed as completed but the finding is back: reopened;
 * - open but no longer present: closed as resolved;
 * - new: created, highest priority first, while open managed issues stay within `maxOpen`.
 */
export function planIssueSync(existing: readonly ExistingIssue[], desired: readonly DesiredIssue[], options: IssueSyncOptions): IssueSyncPlan {
  const actions: IssueAction[] = [];
  const skipped: SkippedIssue[] = [];
  const byFingerprint = new Map<string, ExistingIssue[]>();
  for (const issue of [...existing].sort((a, b) => b.number - a.number)) {
    byFingerprint.set(issue.fingerprint, [...(byFingerprint.get(issue.fingerprint) ?? []), issue]);
  }
  const wanted = new Set(desired.map((issue) => issue.fingerprint));
  let open = existing.filter((issue) => issue.state === "open").length;

  if (options.closeResolved) {
    for (const issue of existing) {
      if (issue.state !== "open" || wanted.has(issue.fingerprint)) continue;
      actions.push({
        type: "close",
        number: issue.number,
        fingerprint: issue.fingerprint,
        comment: options.resolvedComment ?? "CI/CD Optimizer no longer detects this finding, so this issue is resolved. :tada:",
      });
      open -= 1;
    }
  }

  const pending: DesiredIssue[] = [];
  for (const issue of desired) {
    const history = byFingerprint.get(issue.fingerprint) ?? [];
    const current = history.find((candidate) => candidate.state === "open");
    if (current) {
      if (current.signature !== issue.signature || current.title !== issue.title) {
        actions.push({ type: "update", number: current.number, desired: issue, ...(current.copilotPending ? { retryCopilot: true } : {}) });
      } else if (issue.assignCopilot && current.copilotPending) {
        actions.push({ type: "assign", number: current.number, desired: issue });
      }
      continue;
    }
    const latest = history[0];
    if (latest?.stateReason === "not_planned") {
      skipped.push({ fingerprint: issue.fingerprint, reason: "dismissed", number: latest.number });
      continue;
    }
    pending.push(issue);
  }

  for (const issue of pending.sort((a, b) => b.priority - a.priority || a.fingerprint.localeCompare(b.fingerprint))) {
    if (open >= options.maxOpen) {
      skipped.push({ fingerprint: issue.fingerprint, reason: "limit" });
      continue;
    }
    const latest = byFingerprint.get(issue.fingerprint)?.[0];
    actions.push(latest ? { type: "reopen", number: latest.number, desired: issue } : { type: "create", desired: issue });
    open += 1;
  }
  return { actions, skipped };
}
