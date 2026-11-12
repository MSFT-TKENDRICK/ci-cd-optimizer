import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { feedbackPrompt, feedbackPromptVersion } from "../../scripts/feedback-harness.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error("Usage: node evals/feedback/prepare-activation.mjs <new-artifact-directory>");
const output = resolve(root, destination);
const within = relative(join(root, ".agent-artifacts"), output);
if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Use a new directory within .agent-artifacts");
execFileSync(process.execPath, [join(root, "evals", "skills", "prepare.mjs"), join(output, "skills")], { cwd: root, stdio: "inherit" });
const prompt = feedbackPrompt({
  key: "1:2:1", repository: "acme/widgets", repositoryId: 1,
  producer: { id: 2, run_attempt: 1, created_at: "2026-11-12T00:00:00Z" },
  benchmark: {
    schema: "cicd-optimizer/benchmark-v1", repository: "acme/widgets", repositoryId: 1,
    runId: 123456789, runAttempt: 2, findings: [], jobs: [],
    gaps: ["Offline fixture: reports and logs are unavailable."],
  },
});
const spec = `name: ci-broadcast-activation
description: Generated from the production composer; revision ${feedbackPromptVersion}.
version: "1.0"
type: capability
agent_environment:
  files:
    - src: ${JSON.stringify(join(output, "skills"))}
      dest: .
    - src: ${JSON.stringify(join(root, "evals", "skills", "fixtures", "AGENTS.md"))}
      dest: AGENTS.md
defaults:
  executor: copilot-sdk
  runs: 3
  timeout: 90s
scoring:
  threshold: 1.0
stimuli:
  - name: composed-broadcast
    prompt: ${JSON.stringify(prompt)}
    graders:
      - type: skill-invocation
        config: { required: [analyze-ci-run, optimize-ci-pipeline], disallowed: [triage-cicd-findings] }
      - type: diff-empty
      - type: tool-calls
        config:
          disallowed: ["^(bash|powershell|shell|create|edit|apply_patch|web_fetch|web_search)$"]
`;
await writeFile(join(output, "eval.yaml"), spec, { flag: "wx" });
