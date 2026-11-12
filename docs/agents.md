# Agent interfaces

CI/CD Optimizer's core lint engine is available to developer agents without running repository code or granting
write access. The shipped interfaces are:

| Interface | Transport | Capability |
|---|---|---|
| `cicd-mcp` | Local stdio | Workspace linting, unsaved content, rule/configuration lookup, review-project validation, and exact autofix previews |
| `cicd-mcp --enable-remote --repo owner/repo` | Local stdio; outbound GitHub reads | The above, plus repository scans and completed-run reports for explicitly allowlisted repositories |
| `cicd-acp` | Local ACP v1 over stdio | Deterministic lint/preview/explanation commands in the client's session directory |
| GitHub App `/acp` | Opt-in ACP v1 HTTP/SSE | Authenticated repository scans, run reports, and built-in rule documentation; **no server-local filesystem access** |
| [Agent plugin](../plugins/ci-cd-optimizer/) | Bundled MCP server, skills, and custom agent | The canonical developer-agent integration, requiring Node.js 22+ but no dependency installation or build |

These are implemented transports, not a public hosted service. There is **no public deployment or npm registry
release**. Build/install a checkout, use its committed plugin bundle, or enable `/acp` on infrastructure you operate.
The [setup MCP App](setup.md) is a separate, owner-operated provisioning interface; it is not the read-only linter.

## Install from a checkout

With Node.js 22+:

```powershell
git clone https://github.com/MSFT-TKENDRICK/ci-cd-optimizer
Set-Location ci-cd-optimizer
npm ci
npm run build
npm link
cicd-mcp --help
cicd-acp --help
```

`npm link` exposes `ci-cd-optimizer`, `cicd-lint`, `cicd-mcp`, and `cicd-acp`. Alternatively, `npm pack` builds an
installable `ci-cd-optimizer-0.2.0.tgz`, including the canonical plugin and this documentation. Install that tarball
from its actual filesystem path with `npm install`. From the source checkout, `npm run agents:mcp -- --root C:\src\my-repo`
and `npm run agents:acp` run the same entry points through `tsx`.

Do not run a protocol server through an npm wrapper in an editor configuration: npm's banner can contaminate stdout.
Use `node` with an absolute bin path, the linked executable, or the plugin bundle as shown below.

## Canonical plugin and skills

The plugin lives at [`plugins/ci-cd-optimizer`](../plugins/ci-cd-optimizer/). Its marketplace manifest is
[`.github/plugin/marketplace.json`](../.github/plugin/marketplace.json). In a compatible Copilot CLI:

```text
/plugin marketplace add MSFT-TKENDRICK/ci-cd-optimizer
/plugin install ci-cd-optimizer@ci-cd-optimizer
```

The single maintained skill set is:

- [`optimize-ci-pipeline`](../plugins/ci-cd-optimizer/skills/optimize-ci-pipeline/SKILL.md): evidence, ranked findings,
  exact previews, reviewed edits, and verification.
- [`triage-cicd-findings`](../plugins/ci-cd-optimizer/skills/triage-cicd-findings/SKILL.md): explain findings and propose
  precise suppressions, with permission before changes.
- [`analyze-ci-run`](../plugins/ci-cd-optimizer/skills/analyze-ci-run/SKILL.md): authenticated read-only run analysis.

For another skill-capable client, point its skill discovery at those directories; do not maintain copied variants.
In this repository, [`.github/skills`](../.github/skills/) contains generated, self-contained mirrors so
[Copilot's native project discovery](https://docs.github.com/en/copilot/concepts/customizations/agent-skills)
can load the same skills without installing the plugin. Connecting an MCP server alone does **not** install skills.
After changing a canonical skill, run `node scripts/sync-skills.mjs --write`; `--check` and the existing manifest
tests reject missing or divergent mirrors. Full copies avoid symlink portability and out-of-skill reference
problems on Windows; the procedure and metadata are maintained only in the plugin source.
In a fresh session rooted in this checkout, `copilot skill list` should list all three. Other repositories still
need the plugin or an explicitly configured skill source. An existing session may need a reload/new session.
The custom agent is in `com.github.copilot/agents/ci-cd-optimizer.agent.md`. Host-provided editing tools are separate:
the agent must show the exact proposed change and get permission before using them.

The committed `server/cicd-agents.mjs` supports `mcp`, `acp`, and the ordinary `lint` CLI. It needs only Node.js 22+.
Plugin servers may start in the plugin's install directory, not the user's repository. Therefore the skills pass
an absolute `root` to workspace tools. The server refuses to analyze the plugin install directory when
`CICD_OPTIMIZER_PLUGIN_ROOT` or `PLUGIN_ROOT` identifies it.

### Evaluate skill activation

The [Vally suite](../evals/skills/eval.yaml) tests actual Copilot `skill_activation` trajectory events, not
keyword matches or responses claiming to use a skill. It stages a small read-only fixture and relies on native
`.github/skills` discovery: **do not add `--skill-dir`**, which would mask a broken repository layout.
Eight frozen stimuli cover the dashboard follow-up, runner work, monorepo caching, exact-attempt Gantt analysis,
triage, application latency, dashboard styling and hostile quoted-log instructions. Three repetitions each
check routing, no file changes and no shell/edit/web calls. This evaluates activation, not optimization quality
or tool execution; the fixture deliberately has no live CI tools, credentials or application.

Use Node.js 22.15+ and existing authorized Copilot authentication, following
[Vally runtime setup](https://microsoft.github.io/vally/get-started/runtime-setup/).
Do not commit credentials. Vally isolates runtime settings by default; host-home mode can introduce personal
skills/configuration and should not be used for comparable results. Model-driven evals consume credits and are
explicitly opt-in, not added to every CI run. The ordinary manifest tests protect discovery/parity for free.
The fixture instructions and graders are not an OS sandbox: Vally's executor may approve tool permissions.
Stage only these inert skill files, not a live checkout, executable project configuration or secrets.

From the repository root (choose a baseline commit and unused output directories):

```powershell
node scripts/sync-skills.mjs --check
node evals/skills/prepare.mjs .agent-artifacts/skill-eval/baseline <baseline-commit>
node evals/skills/prepare.mjs .agent-artifacts/skill-eval/treatment
npm exec --yes --package=@microsoft/vally-cli@0.21.0 -- vally lint .github/skills --eval-spec evals/skills/eval.yaml
npm exec --yes --package=@microsoft/vally-cli@0.21.0 -- vally eval --eval-spec evals/skills/eval.yaml --param SKILL_TREE=../../.agent-artifacts/skill-eval/baseline --workers 2 --require-pass --output-dir .agent-artifacts/skill-eval/baseline-results
npm exec --yes --package=@microsoft/vally-cli@0.21.0 -- vally eval --eval-spec evals/skills/eval.yaml --workers 2 --require-pass --output-dir .agent-artifacts/skill-eval/treatment-results
```

`prepare.mjs` snapshots only the three canonical skills and any native mirrors; it refuses to overwrite a
fixture. Missing native mirrors are allowed in a historical control so the **activation grader**, not setup,
detects the original bug. Baseline failure is expected for a revision without discovery entries.
Keep `results.jsonl` and native session logs under ignored `.agent-artifacts`, record the actual executor/model,
sample counts and failures, and distinguish missing evidence from passes. Check `skill_activation` events and
the skill catalogue in native `system.message` events when diagnosing discovery versus routing.
Treat logs as potentially sensitive; do not publish them without review. A small passing suite is not a
guarantee across all models, clients or future prompts.

#### Recorded activation evaluation

On 2026-11-12, Vally 0.21.0 used `copilot-sdk` / Copilot 1.0.109 with the observed default model
`claude-sonnet-5.5`. The same eight prompts and graders were used for each 24-trial run, with no explicit
skill injection or host-home opt-in.

| Variant | Required activation passes | Negative-control passes | Execution errors |
|---|---:|---:|---:|
| Baseline `ee8a87f203e62d7edc8a6b8aaa3f9d328505644d` | 0/15 | 9/9 | 0 |
| Native mirrors and procedure guidance, original descriptions | 14/15 | 9/9 | 0 |
| Native mirrors and revised descriptions | 14/14 evaluable | 9/9 | 1/24 attempts |

The final run's remaining `runner-work` trial disconnected before completing. A targeted one-trial rerun
using the identical snapshot, prompt and graders passed; the error remains recorded, not counted as a pass.
The exact dashboard follow-up went from 0/3 to 3/3. All completed final trials passed the no-change and
no-execution checks. These are activation results, not measured CI savings or proof of a universal routing rate.

Run IDs, in table order: `7498884c-0392-4026-8774-20054379a3fa`,
`e143f20e-441e-4419-a987-fb146932bdc3`, `cb991048-2ec6-430f-9909-64a7c585a7df`;
the infrastructure retry is `c98f78d7-c22b-4522-87c5-ac1b4e30d331`.
Earlier diagnostics also matter: a link-wrapper prototype failed static reference validation and was
discarded; a native single-trial smoke with original descriptions missed activation despite a populated
catalogue; an explicit-load smoke passed but was excluded from the native-discovery results.
The small non-interleaved samples do not establish that the revised descriptions alone caused improvement.

### Evolve benchmark feedback as a skill

The broadcast harness now composes its existing immutable evidence/authorization contract with the canonical
[`benchmark-feedback.md`](../plugins/ci-cd-optimizer/skills/optimize-ci-pipeline/references/benchmark-feedback.md)
procedure, then the untrusted JSON evidence. A SHA-256 revision identifies the exact contract and procedure;
payload text cannot choose a procedure or candidate. Native skill mirrors and Vally snapshots include
references, not just `SKILL.md`. Event validation, repository authorization, receipt-before-ack ordering,
denial handling and replay-gap behavior remain unchanged. Prompt text is not a security sandbox: existing
tool approvals and code-level validation remain necessary.

The evolution surfaces are deliberately separate:

| Method | Integration and scope |
|---|---|
| [Microsoft SkillOpt](https://github.com/microsoft/SkillOpt) | The pinned `skillopt==0.2.0` package's actual `skillopt.evaluation.gate.evaluate_gate` requires strict validation improvement. This is core-library integration, not the full research trainer. |
| [SkillOpt-Sleep](https://microsoft.github.io/SkillOpt/docs/sleep/) | Its actual `consolidate` runs replay, train-failure reflection, bounded edits and validation through repository-owned Copilot backends: text-only decisions or isolated synthetic MCP calls. No broad session harvesting, memory changes, schedules or adoption. |
| [SkillOpt-Lite](https://github.com/EvolvingLMMs-Lab/SkillOpt-Lite) | Adapted [skill-only loop](../.github/prompts/skillopt-feedback.prompt.md): frozen splits, baseline, bounded edits, validation selection and final test. |
| HarnessOpt | Adapted [harness-only loop](../.github/prompts/harnessopt-feedback.prompt.md): reproduce a composition failure, restrict edits, preserve security/delivery semantics, smoke-test and review separately from skill text. |

Lite/HarnessOpt are agent-driven workflows in **EvolvingLMMs-Lab**, linked by Microsoft Research, not two
additional Microsoft-owned Python packages. The upstream examples are adapted rather than executed blindly:
their reset commands, model choices, large evaluation budgets and tool grants are not inherited.

The optional [evaluator](../evals/feedback/evolve.py) uses ten fixed synthetic decision cases: two train,
four validation, four test. Expected typed decision objects remain outside rollout prompts; only train
failures enter reflection. Validation must improve strictly with identical complete case sets and no
per-case regression; final test failures block review eligibility. Infrastructure errors abort instead of
becoming successful empty results. All outputs stay under ignored `.agent-artifacts`; even eligible results
are proposals, never live updates. Its working directory/settings are isolated and tools are disabled.
Use existing authorized Copilot authentication; do not change credentials to make an experiment pass.

```powershell
python -m venv .agent-artifacts/skillopt
.agent-artifacts/skillopt/Scripts/python.exe -m pip install -r evals/feedback/requirements.txt
.agent-artifacts/skillopt/Scripts/python.exe -m unittest discover -s evals/feedback -p "test_*.py"
.agent-artifacts/skillopt/Scripts/python.exe evals/feedback/evolve.py --output .agent-artifacts/feedback-evolution/new-round
```

Use a compatible Python with wheels available for the dependencies (x64 Python 3.12 was used on Windows).
The evaluator needs a native `copilot` executable; it refuses a Windows shell shim. It never writes maintained
skills. Review the report and selected snapshot before any manual adoption, then synchronize mirrors.
After a test split has been inspected, subsequent runs are regression checks; create and freeze a new,
reviewed holdout before making a new generalization claim.

For native activation, `node evals/feedback/prepare-activation.mjs .agent-artifacts/feedback-activation/new-round`
creates an inert skill-only snapshot and Vally spec using the **actual production prompt composer**.
Run `vally eval --eval-spec .agent-artifacts/feedback-activation/new-round/eval.yaml --require-pass`
with the pinned Vally setup above. Three trials require real activation of both analysis and optimization
skills, no file changes and no shell/edit/web calls. This does not bypass the earlier fixture/sandbox warning.

On 2026-11-12 the real SkillOpt/Sleep evaluation made 14 Copilot rollouts across the ten unique cases:
2/2 train, 4/4 validation before and after, and 4/4 final test decisions passed. The CLI was 1.0.109-1;
its default concrete model was not captured. There were no training failures and no proposed edits;
both official gates retained the incumbent on the 1.0-to-1.0 tie. **No learned quality improvement is
claimed and no candidate was adopted.** The manually authored initial procedure is a reviewed integration
change, not a claim that training discovered it. This small, text-only decision suite does not measure native
skill activation, actual report pagination/tool execution or CI runtime; retain the separate Vally and
delivery regressions for those boundaries.

The production-composed broadcast also passed all three native Vally activation trials, loading both
`analyze-ci-run` and `optimize-ci-pipeline`, with no file changes or shell/edit/web calls. Run ID:
`0d1a8870-348e-4c07-94fd-2a4d5816f12e`. This is a narrow positive activation check, not a measured improvement
over the previous broadcast or a universal activation guarantee.

#### Behavioral refinement loop

[`behavior.py`](../evals/feedback/behavior.py) evaluates **actual native MCP calls**, not just text
classification. It uses the same guarded renderer as production, but only an inert fixture server is
available to the agent. The server exposes exact-attempt reports and a disposition recorder; it cannot
contact GitHub, edit files, acknowledge real events or execute quoted commands. Pagination uses smaller
fixture pages while preserving the report's independent job/step/finding/gap and per-finding evidence
cursors. A separate deterministic grader checks every cursor combination, source-run identity rather
than telemetry-producer identity, numeric conclusions, ordering, supplied-URL provenance, and a handoff
of at most 80 words. Empty findings do not establish a zero savings estimate: absent bounds stay unknown.
Known-good and deliberately broken traces calibrate the grader.

```powershell
.\.agent-artifacts\skillopt\Scripts\python.exe evals\feedback\behavior.py --output .agent-artifacts\feedback-loop\new-run
```

Each run freezes a Loop Card and hashes before evaluation, with two A/A batches and three trials per
case/procedure. Train reflection never receives validation/test cases. Sleep's protected-region editor
holds the complete procedure as one JSON-encoded learned item; the wrapper is decoded before rendering,
never sent as agent instructions or adopted into the skill. Official Sleep and SkillOpt gates use a
strict utility improvement (case pass rate minus a bounded procedure-size penalty). The additional keep
bar requires **no per-case regression**, plus either pass-rate gain above A/A variation or at least 15%
fewer instruction bytes at equal behavior. Every non-style validation check must pass, so aggregate
improvements cannot hide a newly failed guard. Instruction bytes include the unchanged contract and
revision envelope, but exclude unchanged event JSON. A shorter procedure alone cannot hide a behavior regression.

The loop stops after two successive non-qualifying proposals, four rounds, 120 native CLI invocations
(including proposals), or 45 minutes. Each CLI invocation can contain multiple model turns; this is not
a model-request or token ceiling. Leash exhaustion is inconclusive, not convergence. Identical task/procedure replays reuse their
three stored trials; cached reads are not extra samples. The final test slice is run only after selection;
every selected test trial must pass without regression. Usage files capture the native CLI's actual model
and consumption. Artifacts include accepts, rejects, traces and candidate snapshots, but never update the
maintained skill or live extension automatically.

An invalid grader invalidates the apparent plateau. Preserve the rejected report, calibrate the correction,
and freeze a new Loop Card and holdout rather than retroactively relabeling the old test result as a win.
The narrowly scoped `--confirm-run <prior-run-directory>` mode supports one fourth proposal after a
three-proposal run. It verifies unchanged fixture content, regrades cached train/validation traces,
uses `confirmation-cases.json` only for the final test, and carries forward the original CLI count and
start time. It does not reset the leash or establish convergence after an instrument change. Once those
confirmation cases have been inspected, they too are regression cases, not a fresh holdout for future work.

#### Recorded behavioral refinement

The [sanitized Loop Card and ledger](../evals/feedback/behavior-results.json) preserves all four proposals,
including rejects. On 2026-11-12 the initial A/A batches both passed 3/9 full cases; identity, pagination,
numeric and ordering checks already passed, so the validation gain was primarily a more concise handoff.
Proposal 1 reached 9/9 validation, but the final gate rejected it. Inspection found a defective clean-case
oracle (zero rather than unknown savings and contradictory omission metadata), plus fabricated evidence
URLs that the grader missed. That report remains rejected, not retroactively called a successful plateau.

After correcting the instrument and freezing two new confirmation cases, proposal 4 passed 9/9 validation
and 6/6 fresh confirmation trials versus 2/6 for the incumbent. It also passed 6/6 previously exposed,
corrected regression trials. The selected procedure reduces LF-normalized instruction bytes from 3,156
to 2,637 (**16.4%**), with the protected contract unchanged. It is staged for review, not live adoption.
The recorded work comprises 87 native evaluation trials and four proposal launches: 91 CLI invocations.
All 87 evaluation usage files reported the default `gpt-6.1-sol`, totaling 383 model requests; proposal
request counts were not captured. The v1 card's "model invocations" label was incorrect: the implemented
ceiling counted CLI launches, not model requests. Earlier calibration smokes and separate SDK activation
trials are outside that refinement counter.

Vally run `a1e852cf-ae94-4157-af6c-058d4de8e7b8` then passed all three native activation/no-change/no-execution
trials with observed default `claude-sonnet-5.5`. Post-hoc inspection found handoffs of 79, 76 and 101 words:
**one exceeded the requested cap**, which was not an activation grader. Thus the synthetic conciseness gain
does not establish perfect full-SDK generalization. The four-proposal leash ended without another edit;
corrected-instrument convergence and a logarithmic decline remain unproven. Future refinement requires a
new card and fresh held-out cases, not relabeling these exposed results. No merge, live extension reload,
deployment, authority expansion, or CI-only training dispatch was performed.

This instrument measures bounded report triage and handoff clarity, **not** native skill activation,
repository remediation, CI runtime savings, or unrestricted-agent safety. Withheld synthetic cases are
not production traffic and become regression cases once exposed. Prompt size is deterministic, not a
latency claim; a short plateau is not evidence of a mathematical logarithmic law.

## Local MCP

Example editor configuration (replace the two filesystem paths with your checkout and workspace):

```json
{
  "mcpServers": {
    "ci-cd-optimizer": {
      "command": "node",
      "args": [
        "C:\\src\\ci-cd-optimizer\\dist\\mcp-bin.js",
        "--root",
        "C:\\src\\my-repo"
      ]
    }
  }
}
```

For a zero-build installation, replace `dist\mcp-bin.js` with
`plugins\ci-cd-optimizer\server\cicd-agents.mjs` and put `"mcp"` immediately after that script in `args`.
The protocol is newline-delimited JSON on stdout; startup/errors go to stderr.

### Tools and resources

| Tool | Important inputs |
|---|---|
| `lint` | `root?`, `paths?`, `minSeverity?`, `limit?`, `config?`, `presets?`, `rules?`, `rulesets?` |
| `lint_content` | As above, with `content: [{path, text}]` replacing/adding files only in memory |
| `fix_preview` | `root?`, `paths?`, `ruleIds?`, optional unsaved `content` and configuration overrides |
| `list_rules` | `ruleset?`, `preset?`, `kind?`, `fixable?`, `query?`, `limit?` (default 50, maximum 100) |
| `explain_rule` | `id`, `root?`, `config?` |
| `effective_config` | `root?`, `config?`, `presets?`, `rules?`, `rulesets?` |
| `validate_review_project` | `root?`, root-relative `path` to `project.yaml` |
| `scan_repository` (opt-in) | `repo`, `ref?`, `minSeverity?`, `limit?` |
| `workflow_run_report` (opt-in) | `repo`, positive numeric `runId`, `runAttempt?`, `jobOffset?`, `stepOffset?`, `findingOffset?`, `evidenceOffset?`, `gapOffset?`, `markdown?` |

Results include structured JSON and equivalent text. `cicd://config` and `cicd://rules/<rule-id>` are JSON resources;
`optimize-pipeline` and `triage-findings` are prompt templates. Rule resources use built-in defaults when no usable
workspace is available. There are **no file-write, push, issue, pull-request, shell, or permission-approval APIs**.

Workspace selection is `--root`, then the client's first usable local MCP root, then the server's working directory.
An explicit tool `root` must remain under `--root`, or under a client-shared root when there is no fixed root.
Failed `roots/list` requests fail closed. When neither boundary exists, a trusted local client may select any
absolute local directory; this is **not** an operating-system sandbox. Use `--root` for confinement. Symlink escapes
and non-regular input files are rejected. Path selectors filter results, not the cross-file analysis.

### Explicit remote reads

Remote tools are absent by default, even when `GITHUB_TOKEN` or `GH_TOKEN` exists. They require all three:

1. Process-start flag `--enable-remote`.
2. One or more explicit `--repo owner/repo` entries, up to 100. Git remotes never establish authorization.
3. `GITHUB_TOKEN` (preferred) or `GH_TOKEN`, provisioned in the server process environment by the operator/client's
   secret settings; alternatively, explicitly select `--github-cli-auth` for an existing github.com `gh` login.
   These modes never fall back to each other. Never put a token in chat, committed configuration, command arguments, or logs.

Start the server after provisioning that environment:

```powershell
cicd-mcp --root C:\src\my-repo --enable-remote --repo acme/widgets
# Or the committed plugin bundle:
node C:\src\ci-cd-optimizer\plugins\ci-cd-optimizer\server\cicd-agents.mjs mcp --enable-remote --repo acme/widgets
```

Use a narrowly scoped user token with repository metadata, contents, and Actions read access. Local MCP can use an
operator-configured HTTPS `GITHUB_API_URL` for an enterprise API; repository content cannot change that origin.
Every repository read rechecks access, canonical name, and numeric identity. Local MCP pins the repository ID on
first use until restart; hosted ACP requires IDs pinned in deployment configuration. JSON redirects are disabled.
The exact Actions job-log endpoint may follow one validated HTTPS signed-storage redirect without forwarding credentials.

Remote operations are dry runs: they do not publish checks/SARIF, synchronize issues, run experiments, write
telemetry to a database, or open fix PRs. Run reports fetch recent comparison data through the same bounded reader;
they do not expose the App's privileged installation client or persistent telemetry history.

### Remote result completeness

A remote scan with parse failures or incomplete inventory has `status: "partial"` and `analysisComplete: false`.
`inventoryComplete: true` means enumeration finished without omitting relevant files, **not** that every file parsed successfully. A scan that
did not run also has `analysisComplete: false`. Diagnostic severity counts do not include parser failures:
inspect `parseProblemCount`, `parseProblems`, and `omittedParseProblems` independently. Up to 100 parse problems
are returned with path, line, bounded message, and `omittedCharacters`; counts cover all problems encountered
in the analyzed inventory. Hosted ACP renders up to 50 problems and reports its own remaining text omission
count. Zero diagnostics never imply clean analysis when parse problems or coverage gaps exist.

Run-report `status: "processed"` means a snapshot was produced, not that telemetry is complete. Inspect
`analysisStatus` (`complete` or `partial`), `warnings`, and `provenance`: collector/version, collection time,
`jobsComplete`, and `definitionKnown` are retained from the snapshot. Markdown/ACP also states collection
provenance and warnings. Collection requests at most five pages of 100 jobs per run attempt.

| Report field | Meaning |
|---|---|
| `jobsTotal` | Consistent, valid upstream `total_count`; `null` if unknown or inconsistent, never a substitute fetched count |
| `jobsFetched` | Distinct job IDs actually fetched for this run attempt |
| `jobsAnalyzed` | Fetched jobs with the timestamps needed for analysis |
| `jobsNotFetched` | Known upstream total minus fetched jobs, or `null` when the total is unknown |
| `jobPagesFetched` | Pages fetched for this run attempt, excluding historical comparison runs |
| `jobs` / `omittedJobs` | Up to 100 analyzed jobs / analyzed jobs omitted **from this response only** |

For example, a 501-job run capped at five pages reports 500 fetched jobs, 100 returned jobs, 400 response-omitted
jobs, and one upstream job not fetched. It does not claim that output pagination covers the missing job.
When collected job telemetry is incomplete, `run.durationMs` is `null`, `criticalPath` and per-job
`onCriticalPath` are absent, and baseline comparisons are withheld. Unknown workflow definitions also suppress
critical-path metrics. Individual job/step timings remain measurements of the collected subset, not a complete
ranking of the run. A Gantt chart likewise covers only returned, non-skipped jobs. Skipped jobs remain in the
inventory and pagination counts, but their possibly synthetic or reversed timestamps are not execution intervals.
Markdown reports their omitted timeline count; a page with no executed jobs shows a message instead of a chart.
Missing fields are unavailable evidence, not zero durations or proof that a job is off the critical path.

Use each `pages` entry's `nextOffset` to retrieve the remaining collected jobs, steps, findings and gaps.
Evidence pages use `nextEvidenceOffset` per finding. Supply `runAttempt` to retrieve that exact attempt,
including historical attempts, and keep it fixed across pages. Text is bounded and sanitized. Pagination covers
collected evidence only, not missing logs or upstream inventory. Runner-work percentages use observed job durations,
not billed cost or elapsed wall-clock shares.

A dependency download-cache hit can still leave measurable installation work. The report separates the
setup/cache action from its immediately following install, including inside composite actions; a hit does not
prove that no network access occurred. Nested measured intervals explain only their own time, so significant
unclassified time elsewhere in a composite remains a coverage gap. These bounds overlap repeated-setup
findings and must not be added together.

When a critical-path step's unexplained time includes a long stretch with no log output, the coverage gap says the log
cannot show where that time went and asks for phase markers. It is an observability gap, not a bottleneck or removable
cost; a step that printed progress, or whose quiet time a recognized pattern already explains, keeps its original wording.

## Per-run feedback and harness startup

The trusted default-branch telemetry workflow benchmarks every independently triggered workflow except itself,
including failed, cancelled and rerun attempts. It pins `--run-attempt` from the completion event so a newer retry
cannot replace the triggering attempt. Tests keep its explicit trigger list complete without recursive
telemetry runs; reusable-only workflows are included through their callers. `telemetry --broadcast` writes a bounded,
SHA-256-integrity-framed benchmark into its job log. The MCP watcher verifies the producer workflow, default branch,
repository numeric identity and exact source attempt/SHA before exposing it as
`cicd://feedback/runs/<repository-id>:<producer-run>:<producer-attempt>`.
Integrity framing alone is not authentication. Legacy producer runs without frames are coverage errors.

Benchmarking stays **per run; optimization broadcasts are actionable-only and success-gated**. The watcher publishes a run resource
only for a successful source attempt, when analysis is available and at least one identified bottleneck has a nonblank summary, remediation
recommendation and supporting evidence. Clean/skipped reports without findings, gap-only or unavailable analysis,
omission counts alone, and findings without remediation or evidence do not enqueue agent instructions.
They remain in the producer's benchmark log and on-demand reports. Successfully filtered producers are marked
processed within the replay scope without occupying an outbox slot or requiring an acknowledgement; the status
resource's process-lifetime `filtered` count records these decisions. No broadcast does **not** mean no opportunities.
Savings need not be positive: generated-artifact drift and cache-save failures can warrant fixes without proven
removable work. A qualifying partial report still broadcasts its full bounded payload, including
gaps and omissions; the receiver must verify applicability and retrieve exact-run evidence before remediation.

Each repository/workflow/source-branch/trigger series starts broadcasting at its first actionable success **within
the replay scope**, not the workflow's lifetime. Failures, cancellations, skipped attempts and unavailable analyses
are held until the next qualifying success. Its `rollup` contains up to 20 exact run/attempt summaries,
explicit omitted-run and conclusion counts, non-success runner work (rework exposure, never removable cost),
and the number of quiet successes. Full evidence remains in producer logs and exact-run reports.
Duplicate producers for the same source attempt do not inflate rollups. A quiet success does not flush a rollup.

Later successes broadcast only for a new evidenced finding, a changed complete job set, newly available whole-run
metrics, or a substantial duration change relative to the **last broadcast**, allowing gradual drift to accumulate.
Run-specific numeric job ids are removed from finding identities; different finding details remain distinct.
Novel actionable evidence can therefore notify even with unchanged timings. Execution elapsed, queue-inclusive
latency, total runner work and per-job durations are compared separately, never added.
Metric comparisons require complete whole-run metrics, no omitted jobs, and identical job keys/names (including
matrix multiplicity). Trigger type is separated, but equal job sets do not prove identical dispatch inputs,
runner resources or workloads; this is a notification filter, not an experiment or causal improvement claim.

The fixed duration heuristic rejects absolute changes below 1 second and compares `ln(ms + 10,000)`.
The base threshold is `ln(1.1)`. With at least three earlier comparable successes, the threshold becomes
`min(ln(2), ln(1.1) + 2 * 1.4826 * MAD(log durations))`, using at most ten samples and excluding the current
observation. These are product noise-filter choices, **not** validated human-perception constants, p-values
or statistical significance. The cap applies to offset durations, not raw doubling. Thus 75 vs 73 minutes
is quiet, 60 vs 10 minutes and 40 vs 120 minutes notify, and 40 vs 120 microseconds is quiet.
Incomplete metrics and older delayed successes do not contaminate recent variability or replace the reference.
No broadcast does not establish stability when evidence is missing.

```powershell
node scripts/agent-startup.mjs --repo MSFT-TKENDRICK/ci-cd-optimizer --auth github-cli
```

Use `--auth environment` instead when the host provisions `GITHUB_TOKEN` or `GH_TOKEN`; the native extension
requests those exact environment grants. Denial does not authorize another credential route.
The startup script saves nonsecret, explicit repository authorization in ignored `.agent-artifacts/ci-feedback.json`.
It does not infer authorization from a remote or start an orphan daemon. The project's Copilot extension owns the
stdio MCP process through the live harness and subscribes to native resource-list-change events.
Devcontainer startup and Copilot setup steps prepare this configuration. A host supporting Copilot SDK extensions
must load `.github/extensions/ci-feedback`; setup completion alone does not prove a cloud host supports this bridge.
Verify `ci_feedback_connection_status` in the actual session. Reload extensions after configuration changes.
Reload restarts the existing session-scoped MCP server with the current bundle and replay configuration;
it never re-enables a disabled server.
The distroless production App image is not the development container and does not run this editor harness.

The bridge queues fixed remediation guidance plus explicitly untrusted benchmark evidence into its own conversation.
It persists an accepted-message receipt before invoking the native `feedback_ack` tool. Acknowledgement changes only
the MCP process outbox; it never writes to GitHub. Native denial stops delivery retries, not the permission boundary.
Receipt storage is per workspace/session, bounded to 5,000 recent entries. This is **at-least-once**, not exactly-once:
a crash between accepting a message and persisting its receipt can replay the message.

The watcher polls every 60 seconds per allowlisted repository (maximum five), replays at most seven days/1,000
producer runs per repository, and holds 50 unacknowledged events without silently evicting them. Each poll fetches
at most four eligible producers per repository, alternating newest and oldest within a frozen inventory snapshot.
It buffers verified benchmarks until every member (including in-progress or retried producers) has been collected,
then decides in authenticated source-attempt `updated_at` order, with run/attempt tie-breakers. This prevents
a newest-first fetch from broadcasting success without failures elsewhere in that snapshot. New arrivals belong
to the next snapshot, so they cannot perpetually extend the current one. Buffered events respect the same inventory
bound; a full outbox pauses draining without dropping them. `buffered` and `catching-up` distinguish collection
from delivery. An unresolved member blocks its snapshot and remains visible as an error or backlog, not a clean result.
Late arrivals cannot retroactively amend an accepted broadcast; held failures join the next qualifying success.
GitHub's attempt update timestamp is the ordering proxy, not a separately measured end-to-end duration.
Comparison state is process-local and reconstructed from the bounded replay on reconnect; existing receipts prevent
redelivery of the same accepted producer. It is not a permanent lifetime baseline and older replay boundaries or
changed evidence can change decisions. Aged-out unresolved rollups are reported as replay gaps.
Collection and replay gaps remain visible in status/error resources. Long-offline gaps cannot be reconstructed by this bounded feed.
An upstream read timeout is reported explicitly without exposing download URLs, credentials or raw exception messages.
It is incomplete analysis or delivery, not an empty result; existing deadlines, cancellation and retry backoff still apply.
Keep the harness running to receive recommendations; a different session does not share its delivery receipts.
Polling and reconnecting do not trigger CI. Every remediation still follows the user's existing authorization.

Benchmarks distinguish execution, queue-inclusive latency, observed runner work and failed-run rework exposure.
Their previous-run deltas are descriptive, not causal. History is the bounded available snapshot window, not a census
of all earlier attempts. Savings bounds overlap and are not measured improvements. Partial evidence, omitted results,
conditional hypotheses and unmeasured resource costs never establish convergence or universal optimality.

### Prevent generated-artifact rework

Run `npm run ci:prepare` after source changes, review its generated diffs, then run `npm run ci:check-generated`
before pushing. Preparation regenerates rule assurance, proof provenance, both shipped bundles and setup UI output.
The check is read-only and preserves the existing CI parity gates. To opt in to the repository pre-push check:

```powershell
git config --local core.hooksPath .githooks
```

Fresh development/cloud bootstrap installs this hook with `--install-hooks`, refusing to replace an existing hook.
Review an existing hooks configuration before replacing it. Hooks are a local early warning, not a substitute for
CI enforcement or proof verification. A reported artifact failure measures observed rework exposure, not promised savings.

## Local ACP

Configure an external agent with command `node` and argument
`C:\src\ci-cd-optimizer\dist\acp-bin.js`, or use the plugin bundle with the `acp` argument.
The ACP client initializes the connection and creates a session with an **absolute** `cwd`.

```text
/lint
/lint ".github/workflows/release build.yml" --min warn
/fix-preview .github/workflows/ci.yml
/explain workflow/job-timeout
/rules caching
/config
/help
```

This is a command agent, not an LLM chat backend. All text blocks participate in command parsing, including
multiline and quoted path arguments. Embedded text resources replace file contents in memory. Baseline
`resource_link` blocks select local files under the session root. File URLs with malformed encoding, query
parameters, fragments, or paths outside that root fail. Remote attachments are not fetched. Unsupported non-text
blocks are reported as ignored, not interpreted.

Nonempty `mcpServers` and additional session directories are explicitly rejected. No child MCP servers, terminals,
or repository scripts are started. There is no session resume/load, external-model inference, or protocol write
capability. Creating a new session is the supported way to change the workspace; at most eight sessions are kept
per connection, and EOF/connection close discards them.

## Hosted ACP on your own App deployment

Enable the endpoint only on a deployment with a TLS reverse proxy, ingress connection/header/rate limits, and
restricted operational logs. The Node service itself speaks HTTP behind that proxy. Do not expose it directly to
the public internet or forward tokens to another origin.

Set these **process environment** values, not repository YAML:

```dotenv
CICD_OPTIMIZER_ACP=true
CICD_OPTIMIZER_ACP_AUTH=github-user
CICD_OPTIMIZER_ACP_REPOSITORIES=acme/widgets:12345678,acme/service:87654321
```

The names and numeric IDs above are examples. Obtain each actual immutable ID through an authorized
`gh api repos/OWNER/REPOSITORY --jq .id` call. Renames, transfers, or name reuse require an operator-reviewed
configuration update. Empty, duplicate, malformed, or missing restrictions stop startup. Omit
`CICD_OPTIMIZER_ACP` (or set `false`) to leave the endpoint absent.

The endpoint is exactly `/acp` on the existing App listener. It is registered once at direct or Postgres ingress,
never in the webhook consumer. Its path may not also be the webhook path. Shutdown closes ACP connections/SSE
before stopping the HTTP server in both modes.

### Authentication and client flow

Use an ACP HTTP/SSE client that sends an `Authorization: Bearer …` header on **every POST, SSE GET, and DELETE**.
Provision this header using the client's secret store, not a query string. The credential must authenticate a
GitHub **user** at `https://api.github.com/user`; installation tokens are not accepted. Hosted ACP does not use
ambient token/API-origin variables or App installation credentials. Repository metadata must confirm the caller's
pull access and the configured ID before every remote repository read.

1. `POST /acp` with JSON-RPC `initialize` returns `Acp-Connection-Id`.
2. Send that header on subsequent POSTs, SSE GETs (`Accept: text/event-stream`), and DELETE.
3. Create a session with `session/new`, `mcpServers: []`, and a syntactically valid `cwd`. Hosted mode does not read
   or resolve that directory. The response and command advertisement arrive over SSE.
4. Session requests and streams use the returned `Acp-Session-Id`; the SDK enforces matching session headers.
5. Send commands, then `DELETE /acp` to release the connection.

Connections bind to both numeric user identity and credential fingerprint. Another user **or another token for
the same user** cannot reuse them. Tokens are revalidated on every HTTP request; SSE has a maximum 60-second lease
before reconnect/authentication. A connection expires after ten minutes; initialize a new one after expiry.
Repository access is checked during operations rather than trusted from connection creation.

Hosted commands:

```text
/scan acme/widgets
/scan acme/widgets main
/report acme/widgets 123456789
/rules timeout
/explain workflow/job-timeout
/help
```

Hosted sessions reject file attachments and local commands (`/lint`, `/fix-preview`, `/config`); no server-local
filesystem data is exposed. Browser-origin/CORS access, URL tokens, query parameters, JSON-RPC batches, unknown
methods, unsupported HTTP verbs, and forged connection/session IDs are rejected. There is no unauthenticated mode.

## Bounds, cancellation, and interpretation

Hard ceilings are not raised by repository configuration:

| Budget | Ceiling |
|---|---|
| Local/hosted protocol input | 256 KiB per message/body; ACP prompts also at most 32 blocks |
| Tool/update output | 128 KiB per MCP tool envelope or ACP update, with space reserved for protocol framing |
| Local analysis | 250 files, 256 KiB per file, 4 MiB aggregate including unsaved overrides; 20,000 visited entries, depth 40 |
| Local configuration / overrides | 64 KiB config; at most 20 content overrides, 200 selectors |
| Diagnostic page | Default 100, maximum 500; ACP shows at most 50 |
| Exact previews | At most 20 complete file diffs and 64 KiB combined before/after UTF-8 text |
| Work | Two concurrent local operations; hosted four globally, two per user; one prompt per ACP session |
| Hosted connections / sessions | 32 connections globally, four per user; eight sessions and eight pending RPC requests per connection |
| Hosted HTTP / SSE | 32 ordinary requests globally/eight per user; 64 SSE streams globally/12 per user, with separate permits |
| Deadlines | 30-second cooperative operation deadline; ten-second HTTP/auth/read deadline; at most one second awaiting child-read cleanup after a command exits |
| GitHub reads | At most 256 requests, 2 MiB per response, 16 MiB response bytes per operation |
| Hosted output buffering | Explicit 256 KiB SDK queue threshold; five-second output-stall timeout |

The SDK counts queued text in UTF-16 code units and may enqueue one final message beyond its threshold; per-message
caps bound that overshoot. Excess work is rejected instead of queued indefinitely. No SDK default unlimited output
buffer is used by the hosted endpoint. Use proxy limits as well; in-process quotas are not a distributed rate limit.

Cancellation aborts pending GitHub fetches and is checked between filesystem/analysis phases. It cannot preempt
synchronous JavaScript parsing or a built-in rule already running. Failed reads cancel their sibling reads and
prevent queued reads from starting; a missing optional configuration/workflow file is not a fatal read failure.
Every command exit aborts and drains owned reads, including errors converted to ACP `end_turn`. The original error
is retained rather than replaced by a sibling's cancellation error. A deadline rejects late results. If a transport
ignores cancellation beyond the cleanup wait, the response can finish but its concurrency permit and ACP session
remain reserved until the underlying reads actually settle. Neither retrying nor creating another session can
reclaim those occupied operation slots. Do not describe this as hard CPU isolation.

Counts describe the analyzed inventory, not unseen files; `filesAnalyzed` includes supported Nix/toolchain inputs
and cross-file configuration, not just workflows. `inventoryComplete: false` means coverage is incomplete:
excluded relevant files and unfollowed links do not establish absence, and unvisited files cannot be counted without
exceeding the traversal budget. Diagnostic/list caps report omitted
counts, text caps report omitted characters, and oversized envelopes report omitted response bytes. Previews never
return half of a file: omitted diffs are flagged and counted. Their `inventoryComplete`, `localRulesIgnored`, and
`parseProblemCount` fields expose coverage limitations; use `lint` for parse-problem details. Narrow selections/queries and retry rather than
applying a truncated result. A byte-limit error is not an empty or clean scan. Local text files must be valid UTF-8:
malformed encoding is rejected rather than replaced in an allegedly exact preview, and UTF-8 BOMs are preserved.

All interfaces use built-in rules only; configured `localRules` are reported as ignored and **never imported**.
The ordinary `cicd-lint`/bundled `lint` CLI is a different trust boundary: it can write with explicit write flags and
executes local rules only with `--allow-local-rules`. Skills must not silently add those flags to bypass a refusal.
Protocol previews always have `written: false`; applying changes is a separate host/user action requiring review
of current file contents and exact user permission.

Repository names, paths, configuration, findings, and tool output remain untrusted data. Structured data is bounded;
rendered repository-derived Markdown is escaped and diagrams use restricted labels. Never follow instructions
embedded in a finding or automatically execute commands/links from repository content.

## Development and verification

```powershell
npm run typecheck
npm run lint
npx vitest run --project service test/agents
npm run build
npm run bundle:agents
npm run test:agents:package
```

The package check packs/extracts under `.agent-artifacts`, checks all four shipped bins and canonical assets, and
performs real stdio MCP/ACP initialize/lint/preview roundtrips against both packed bins and the single-file plugin
bundle. Marker/throwing local rules and unchanged fixture contents/mtime check that these tested reads neither
execute local rules nor write workspace files; these regressions are not a formal proof of every read path.
CI also verifies plugin bundle freshness, authenticated HTTP/SSE adversarial tests, and `/acp` mounting in both
direct and Postgres production images. The shared lint helpers do not import CLI internals; `ENGINE_API_VERSION`
remains `1`.
