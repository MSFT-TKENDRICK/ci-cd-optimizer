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
The custom agent is in `com.github.copilot/agents/ci-cd-optimizer.agent.md`. Host-provided editing tools are separate:
the agent must show the exact proposed change and get permission before using them.

The committed `server/cicd-agents.mjs` supports `mcp`, `acp`, and the ordinary `lint` CLI. It needs only Node.js 22+.
Plugin servers may start in the plugin's install directory, not the user's repository. Therefore the skills pass
an absolute `root` to workspace tools. The server refuses to analyze the plugin install directory when
`CICD_OPTIMIZER_PLUGIN_ROOT` or `PLUGIN_ROOT` identifies it.

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
ranking of the run. A Gantt chart likewise covers only returned jobs. Missing fields are unavailable evidence,
not zero durations or proof that a job is off the critical path.

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

## Per-run feedback and harness startup

The trusted default-branch telemetry workflow benchmarks every independently triggered workflow except itself,
including failed, cancelled and rerun attempts. It pins `--run-attempt` from the completion event so a newer retry
cannot replace the triggering attempt. Tests keep its explicit trigger list complete without recursive
telemetry runs; reusable-only workflows are included through their callers. `telemetry --broadcast` writes a bounded,
SHA-256-integrity-framed benchmark into its job log. The MCP watcher verifies the producer workflow, default branch,
repository numeric identity and exact source attempt/SHA before exposing it as
`cicd://feedback/runs/<repository-id>:<producer-run>:<producer-attempt>`.
Integrity framing alone is not authentication. Legacy producer runs without frames are coverage errors.

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
at most four eligible producers per repository, alternating newest and oldest so current results do not wait
behind the entire replay history and older events still make progress. Alternation survives single-slot backpressure;
delivery order is not chronological.
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
