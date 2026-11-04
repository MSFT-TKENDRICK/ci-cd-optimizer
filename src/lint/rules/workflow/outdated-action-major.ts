import type { StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, stringValue } from "../../parsers/yaml.js";
import type { ReportDescriptor, SourceFile } from "../../types.js";
import { actionVersion, defineRule, steps } from "../helpers.js";

interface Track {
  latest: number;
  /** First major that targets node24; hosted runners force older majors (node20 or earlier) onto Node 24, untested. */
  node24: number;
}

const CACHE: Track = { latest: 6, node24: 5 };
const UPLOAD: Track = { latest: 7, node24: 6 };

/** Latest majors as of 2026-11 (see the rule references); node24 boundaries from each action's action.yml history. */
const TRACKS: Record<string, Track> = {
  "actions/checkout": { latest: 7, node24: 5 },
  "actions/setup-node": { latest: 7, node24: 5 },
  "actions/setup-python": { latest: 7, node24: 6 },
  "actions/setup-go": { latest: 7, node24: 6 },
  "actions/setup-java": { latest: 6, node24: 5 },
  "actions/setup-dotnet": { latest: 6, node24: 5 },
  "actions/cache": CACHE,
  "actions/cache/restore": CACHE,
  "actions/cache/save": CACHE,
  "actions/upload-artifact": UPLOAD,
  "actions/upload-artifact/merge": UPLOAD,
  "actions/download-artifact": { latest: 8, node24: 7 },
};

const RETIRED_RUNTIMES = new Set(["node12", "node16", "node20"]);
const NODE_REMOVAL = "GitHub-hosted runners stopped providing on 2026-09-23; they force such actions onto Node 24";

function upgradeNotes(name: string, from: number, to: number): string {
  const notes: string[] = [];
  if (name === "actions/checkout" && from < 7 && to >= 7) {
    notes.push(
      "checkout v7 refuses to check out fork pull request code under `pull_request_target`/`workflow_run` unless `allow-unsafe-pr-checkout: true` is set.",
    );
  }
  if (name.startsWith("actions/upload-artifact") || name === "actions/download-artifact") {
    notes.push("GitHub Enterprise Server only supports artifact actions v3, so skip this on GHES.");
  }
  if (from < (TRACKS[name]?.node24 ?? 0)) {
    notes.push("Self-hosted runners need Actions Runner v2.327.1 or newer for node24 actions.");
  }
  return notes.length > 0 ? ` ${notes.join(" ")}` : "";
}

function checkStep(
  workflow: WorkflowModel,
  step: StepModel,
  file: SourceFile | undefined,
  report: (descriptor: ReportDescriptor) => void,
): void {
  const action = step.uses?.action;
  const name = action?.kind === "remote" ? action.name : undefined;
  const track = name !== undefined ? TRACKS[name] : undefined;
  if (!step.uses || name === undefined || !track) return;
  const version = actionVersion(step, file);
  if (!version || version.major >= track.latest) return;
  const shown = version.source === "comment" ? `${name}@${step.uses.action.ref?.slice(0, 7) ?? ""} (${version.text})` : `${name}@${version.text}`;
  const retired = version.major < track.node24;
  report({
    path: workflow.path,
    line: step.uses.line,
    key: `${step.key}.uses`,
    message: retired
      ? `${shown} targets Node 20 or older, which ${NODE_REMOVAL}, a runtime that release was never tested on, and warn on every run. The latest major is v${track.latest}.`
      : `${shown} is behind the latest major, v${track.latest}.`,
    suggestion: `Upgrade to ${name}@v${track.latest} (or its full commit SHA with a \`# v${track.latest}\` comment) after reviewing the release notes for breaking changes since v${version.major}.${upgradeNotes(name, version.major, track.latest)}`,
    ...(retired ? { impact: "high" as const } : {}),
    ...(version.source === "comment" ? { confidence: "medium" as const } : {}),
  });
}

export default defineRule({
  meta: {
    id: "workflow/outdated-action-major",
    ruleset: "workflow",
    description: "Well-known actions should use their current major version, and local JavaScript actions should run on node24.",
    rationale:
      "Old majors of the official setup, cache, checkout, and artifact actions miss performance work (faster caching backends, parallel artifact uploads) and, below the node24 releases, target Node 20, which GitHub Actions runners removed on 2026-09-23: they now force those actions onto Node 24, which their authors never tested, and warn on every run (self-hosted runners on unsupported platforms cannot run them at all). Agents copy existing workflow snippets, so one stale pin spreads quickly.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/",
      "https://github.com/actions/checkout/releases",
      "https://github.com/actions/setup-node/releases",
      "https://github.com/actions/cache/releases",
      "https://github.com/actions/upload-artifact/releases",
      "https://github.com/actions/download-artifact/releases",
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/checkout@v4",
      good: "- uses: actions/checkout@v7",
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      checkStep(workflow, step, project.files.get(workflow.path), report);
    }
    for (const action of project.actions) {
      if (action.kind !== "action") continue;
      const using = field(action.source, field(action.source, action.source.doc.contents, "runs")?.value, "using");
      const runtime = stringValue(using?.value)?.trim().toLowerCase();
      if (!using || runtime === undefined || !RETIRED_RUNTIMES.has(runtime)) continue;
      report({
        path: action.path,
        line: using.line,
        key: "runs.using",
        message: `Action declares \`runs.using: ${runtime}\`, which ${NODE_REMOVAL}, a runtime this action was never built or tested for.`,
        suggestion:
          "Change `runs.using` to `node24`, rebuild any bundled `dist/` output, and run the action's tests on Node 24 before releasing a new tag.",
        impact: "high",
      });
    }
  },
});
