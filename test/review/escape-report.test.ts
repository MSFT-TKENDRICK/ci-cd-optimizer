import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/lint/types.js";
import { capComment, escapeInline, MAX_COMMENT_LENGTH, MAX_INLINE_LENGTH } from "../../src/review/escape.js";
import {
  buildReport,
  isSensitive,
  MAX_MARKDOWN_FINDINGS,
  renderJson,
  renderMarkdown,
  reportExitCode,
  REVIEW_BOT_LOGIN,
  reviewMarker,
  SENSITIVE_RULES,
  upsertReviewComment,
} from "../../src/review/report.js";
import type { ReviewOutcome } from "../../src/review/review.js";
import { allRules } from "../../src/lint/rules/index.js";
import { fakeClient } from "../experiments/fixtures.js";
import { REGISTRY, TARGET_ID, TARGET_SHA, TREE_SHA } from "./fixtures.js";

const ZWSP = "\u200B";

function diagnostic(ruleId: string, message: string, overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    ruleId,
    ruleset: ruleId.split("/")[0] ?? "",
    severity: "warn",
    message,
    path: ".github/workflows/ci.yml",
    line: 3,
    column: 1,
    impact: "medium",
    confidence: "high",
    fingerprint: `${ruleId}:${message}`,
    docsUrl: `https://example.invalid/${ruleId}`,
    kind: "rule",
    ...overrides,
  } as Diagnostic;
}

function outcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    project: "widget",
    status: "ok",
    repository: { id: TARGET_ID, fullName: "octo-org/widget", owner: "octo-org", repo: "widget", defaultBranch: "main", sha: TARGET_SHA, treeSha: TREE_SHA },
    problems: [],
    notes: [],
    diagnostics: [],
    filesAnalyzed: 2,
    inventoryComplete: true,
    ...overrides,
  };
}

describe("escapeInline", () => {
  it("neutralizes mentions, references, and URLs with a zero-width space", () => {
    const escaped = escapeInline("ping @octocat and @org/team about #12, GH-3, owner/repo#4 at https://evil.example and www.evil.example");
    expect(escaped).toContain(`@${ZWSP}octocat`);
    expect(escaped).toContain(`@${ZWSP}org/team`);
    expect(escaped).toContain(`#${ZWSP}12`);
    expect(escaped).toContain(`GH${ZWSP}\\-3`);
    expect(escaped).toContain(`:${ZWSP}//`);
    expect(escaped).toContain(`www${ZWSP}\\.`);
    expect(escaped).not.toMatch(/@[A-Za-z]/);
    expect(escaped).not.toMatch(/#\d/);
    // Fullwidth forms are treated like their ASCII counterparts.
    expect(escapeInline("\uFF20octocat \uFF031")).toBe(`\uFF20${ZWSP}octocat \uFF03${ZWSP}1`);
  });

  it("entity-encodes HTML and escapes Markdown syntax", () => {
    const escaped = escapeInline('<img src=x onerror=alert(1)> <!-- hide --> **bold** [link](https://x) `code` |cell| & ![i](y)');
    expect(escaped).not.toMatch(/<|>/);
    expect(escaped).toContain("&lt;img");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("\\*\\*bold\\*\\*");
    expect(escaped).toContain("\\[link\\]\\(https:");
    expect(escaped).toContain("\\`code\\`");
    expect(escaped).toContain("\\|cell\\|");
    expect(escaped).toContain("\\!\\[i\\]");
    expect(escapeInline("a\\b")).toBe("a\\\\b");
  });

  it("defuses workflow commands and keeps everything on one line", () => {
    const escaped = escapeInline("line one\n::set-output name=x::y\r\n::add-mask::secret\u2028next\u0085end");
    expect(escaped).not.toMatch(/[\r\n\u2028\u0085]/);
    expect(escaped).not.toContain("::");
    expect(escaped).toContain(`:${ZWSP}:set\\-output`);
  });

  it("strips bidi controls, zero-width characters, BOM, and C0/C1 controls", () => {
    const escaped = escapeInline("a\u202Eb\u2066c\u2069d\u200Ee\u200Ff\u061Cg\uFEFFh\u200Bi\u200Dj\u0000k\u001Bl\u009Bm\u{E0041}n");
    expect(escaped).toBe("abcdefghijklmn");
  });

  it("caps each string", () => {
    const escaped = escapeInline("a".repeat(MAX_INLINE_LENGTH * 3));
    expect(escaped).toHaveLength(MAX_INLINE_LENGTH);
    expect(escaped.endsWith("…")).toBe(true);
    expect(escapeInline("abcdef", 4)).toBe("abc…");
  });

  it("renders non-strings", () => {
    expect(escapeInline(42)).toBe("42");
    expect(escapeInline(null)).toBe("null");
  });
});

describe("capComment", () => {
  it("leaves small comments alone and truncates large ones at a line boundary", () => {
    expect(capComment("short\n")).toBe("short\n");
    const body = `${reviewMarker("widget")}\n${"x".repeat(100)}\n`.repeat(2000);
    const capped = capComment(body);
    expect(capped.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(capped.startsWith(reviewMarker("widget"))).toBe(true);
    expect(capped).toContain("Report truncated to fit the comment size limit");
  });
});

describe("sensitive findings", () => {
  it("every sensitive rule id exists", () => {
    const ids = new Set(allRules.map((rule) => rule.meta.id));
    for (const id of SENSITIVE_RULES) expect(ids.has(id)).toBe(true);
  });

  it("classifies by rule id or by security-related wording", () => {
    expect(isSensitive(diagnostic("hermeticity/pin-actions", "Pin actions/checkout to a commit SHA"))).toBe(true);
    expect(isSensitive(diagnostic("workflow/timeout", "Job has no timeout"))).toBe(false);
    expect(isSensitive(diagnostic("workflow/other", "Uses pull_request_target with checkout"))).toBe(true);
    expect(isSensitive(diagnostic("workflow/other", "Job could leak a TOKEN"))).toBe(true);
    expect(isSensitive(diagnostic("workflow/other", "Fine", { suggestion: "Restrict permissions" }))).toBe(true);
  });
});

describe("buildReport", () => {
  const diagnostics = [
    diagnostic("workflow/timeout", "Job has no timeout"),
    diagnostic("hermeticity/pin-actions", "Pin actions/checkout", { severity: "error" }),
    diagnostic("hermeticity/pin-actions", "Pin actions/setup-node", { severity: "error" }),
    diagnostic("workflow/other", "Untrusted input reaches a run script", { severity: "info" }),
  ];

  it("reduces sensitive findings to counts in public mode", () => {
    const report = buildReport(outcome({ diagnostics }), { public: true });
    expect(report.findings.map((item) => item.ruleId)).toEqual(["workflow/timeout"]);
    expect(report.redacted).toEqual({ count: 3, rules: ["hermeticity/pin-actions", "workflow/other"] });
    expect(report.summary).toEqual({ filesAnalyzed: 2, error: 2, warn: 1, info: 1, inventoryComplete: true });
    const json = renderJson(report);
    expect(json).not.toContain("setup-node");
    expect(json).not.toContain("Untrusted input");
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("3 security-sensitive findings from 2 rules withheld from this public report.");
    expect(markdown).not.toContain("setup\\-node");
    expect(markdown).toContain("npm run cli -- review run projects/widget/project.yaml");
  });

  it("keeps every finding in private mode", () => {
    const report = buildReport(outcome({ diagnostics }), { public: false });
    expect(report.findings).toHaveLength(4);
    expect(report.findings[0]?.severity).toBe("error");
    expect(report.redacted).toEqual({ count: 0, rules: [] });
  });

  it("never reports findings unless consent was verified", () => {
    for (const status of ["consent-failed", "invalid", "paused", "error"] as const) {
      const report = buildReport(outcome({ status, diagnostics, problems: ["nope"] }), { public: false });
      expect(report.findings).toEqual([]);
      expect(report.redacted.count).toBe(0);
      expect(report.summary.filesAnalyzed).toBe(0);
      expect(renderMarkdown(report)).not.toContain("Job has no timeout");
    }
    expect(reportExitCode({ status: "ok" })).toBe(0);
    expect(reportExitCode({ status: "paused" })).toBe(0);
    expect(reportExitCode({ status: "consent-failed" })).toBe(1);
    expect(reportExitCode({ status: "invalid" })).toBe(1);
    expect(reportExitCode({ status: "error" })).toBe(1);
  });
});

describe("renderMarkdown", () => {
  it("escapes every untrusted value", () => {
    const hostile = "@everyone #1 <script>x</script> ::error::boom \u202Eevil\nnew line";
    const report = buildReport(
      outcome({
        repository: { id: TARGET_ID, fullName: "@octo/<b>", owner: "o", repo: "r", defaultBranch: "main", sha: TARGET_SHA, treeSha: TREE_SHA },
        diagnostics: [diagnostic("workflow/@rule", hostile, { path: "@path/<x>.yml", suggestion: "| --- |" })],
        problems: [hostile],
        notes: [hostile],
      }),
      { public: true },
    );
    const markdown = renderMarkdown(report);
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("<!-- ci-cd-optimizer-review:widget -->");
    const body = lines.slice(1).join("\n");
    expect(body).not.toMatch(/<(?!sub>|\/sub>)/);
    expect(body).not.toMatch(/@(?!\u200B)/);
    expect(body).not.toMatch(/#[0-9A-Za-z]/);
    expect(body).not.toContain("::");
    expect(body).not.toContain("\u202E");
    expect(body).not.toContain("evil\nnew line");
    // The table row stays a single row with exactly four cells.
    const row = lines.find((line) => line.startsWith("| warn |"));
    expect(row?.split(/(?<!\\)\|/).length).toBe(6);
  });

  it("falls back to a safe marker name and never prints an unverified SHA", () => {
    const report = buildReport(outcome({ project: "--> <b>", repository: { id: 1, fullName: "a/b", owner: "a", repo: "b", defaultBranch: "main", sha: "`x`", treeSha: TREE_SHA } }), { public: true });
    const markdown = renderMarkdown(report);
    expect(markdown.split("\n")[0]).toBe("<!-- ci-cd-optimizer-review:intake -->");
    expect(markdown).not.toContain("`x`");
    expect(markdown).not.toContain("--> <b>");
  });

  it("caps the number of rendered findings and the comment size", () => {
    const many = Array.from({ length: 450 }, (_, i) => diagnostic("workflow/timeout", `finding ${i} ${"y".repeat(250)}`, { line: i + 1 }));
    const markdown = renderMarkdown(buildReport(outcome({ diagnostics: many }), { public: true }));
    expect(markdown.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(markdown.split("\n").filter((line) => line.startsWith("| warn |")).length).toBeLessThanOrEqual(MAX_MARKDOWN_FINDINGS);
  });
});

describe("upsertReviewComment", () => {
  const marker = reviewMarker("widget");

  it("ignores user comments and other projects' bot comments", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET")) {
        return [
          { id: 1, body: `${marker}\nplanted by a user`, user: { login: "mallory", type: "User" } },
          { id: 2, body: `${marker}\nimpostor`, user: { login: REVIEW_BOT_LOGIN, type: "User" } },
          { id: 3, body: `${reviewMarker("other")}\nother project`, user: { login: REVIEW_BOT_LOGIN, type: "Bot" } },
          { id: 4, body: `quoted\n${marker}`, user: { login: REVIEW_BOT_LOGIN, type: "Bot" } },
        ];
      }
      return { id: 99 };
    });
    await expect(upsertReviewComment(client, REGISTRY, 7, "widget", "report\n")).resolves.toEqual({ action: "created", id: 99 });
    const write = client.calls.at(-1);
    expect(write?.route).toBe("POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
    expect(String(write?.parameters.body).startsWith(`${marker}\n`)).toBe(true);
    expect(client.calls.some((call) => call.route.startsWith("PATCH"))).toBe(false);
  });

  it("updates the bot's own comment for the project", async () => {
    const client = fakeClient((route) => (route.startsWith("GET") ? [{ id: 5, body: `${marker}\nold`, user: { login: REVIEW_BOT_LOGIN, type: "Bot" } }] : {}));
    await expect(upsertReviewComment(client, REGISTRY, 7, "widget", `${marker}\nnew\n`)).resolves.toEqual({ action: "updated", id: 5 });
    const write = client.calls.at(-1);
    expect(write?.route).toBe("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}");
    expect(write?.parameters).toMatchObject({ comment_id: 5, body: `${marker}\nnew\n` });
  });
});
