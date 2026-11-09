# Architecture

CI/CD Optimizer is one TypeScript codebase with three entry points over a shared, side-effect-free core. Rules are pure
functions of a repository snapshot. Everything that talks to GitHub lives in a thin service layer, so the CLI, the
Action, the App, and the hill-climbing workflows all behave the same way.

```text
                  ┌───────────────┐  ┌──────────────────────┐  ┌─────────────────────────────┐
 entry points     │ CLI (bin.ts)  │  │ Action (action.ts →  │  │ App (app.ts, Probot         │
                  │ lint, rules,  │  │ dist-action bundle)  │  │ webhooks)                   │
                  │ scan, …       │  │                      │  │                             │
                  └──────┬────────┘  └──────────┬───────────┘  └──────────────┬──────────────┘
                         └──────────────────────┼─────────────────────────────┘
 service/                         pull-request check · scan · workflow-run · comment commands
                         ┌───────────┬──────────┼───────────┬──────────────┬───────────────┐
 domain           issues/     fixes/     alerts/     telemetry/    experiments/    recipes/
                         └───────────┴──────────┼───────────┴──────────────┴───────────────┘
 core                       lint/  (engine · config · parsers · project model · 62 rules · formatters)
 I/O                        github/  (REST client, repository snapshot, git, code scanning)
```

## Lint engine (`src/lint`)

The MVP and the foundation of everything else. It is modeled on ESLint.

1. **Inventory.** `inventory.ts` selects only CI/CD-relevant files: workflows, composite actions, package manifests,
   lockfiles, workspace configs, and container files. Its bounds keep large monorepos cheap, and pull requests only fetch
   what's needed.
2. **Parsing.** Position-preserving YAML (workflows), Dockerfile, and manifest parsers feed a **project model**: jobs,
   steps, `uses` references, setup actions, caches, workspaces, packages, images, and the change context.
3. **Rules.** Each rule is a `RuleModule { meta, check(context) }` that reports diagnostics with impact, confidence, a
   suggestion, a stable fingerprint, and optional text-edit fixes. It never executes repository code or expands
   expressions. There are 62 rules in 12 rulesets: `workflow`, `checkout`, `affected`, `caching`, `hermeticity`,
   `containers`, `packages`, `registries`, `triggers`, `redundancy`, `testing`, and `security` ([catalog](rules.md)).
4. **Configuration.** Presets, ruleset- and rule-level severities, options, and ignores ([configuration](configuration.md)).
   Rules are tested with an ESLint-style `RuleTester` (valid, invalid, and autofix-output cases).
5. **Change awareness.** `--base` lints the base revision too and keeps only **introduced** findings, so pull requests
   are judged on what they change rather than on legacy debt.
6. **Output.** Formatters for `stylish`, `json`, `github` annotations, `markdown`, and `sarif` (code scanning), plus
   `fix.ts` to apply non-overlapping edits.

`lint/api.ts` is the versioned engine contract. Experiment arms are built against it and scored on the
[benchmark corpus](../corpus/README.md).

## Service layer (`src/service`)

| Service | Trigger | Does |
|---|---|---|
| `pull-request.ts` | PR webhook (App); the CLI and Action get the same result from `lint --base` | Lints head vs base, posts the **CI/CD Optimizer** check with introduced findings. |
| `scan.ts` | Default-branch push, install, or Action `scan` | Lints the default branch, uploads SARIF, then syncs `issues/` and `fixes/`. |
| `workflow-run.ts` | `workflow_run.completed`, or Action `telemetry` | Builds a telemetry snapshot, compares it with history, posts the Gantt/bottleneck check, and syncs `alerts/`. |
| `comments.ts` | `@cicd-optimizer` comments | Rebase, recreate, ignore, and close commands on managed pull requests. |

## Acting on findings

These layers are modeled on Dependabot and GitHub Advanced Security. Every write is idempotent: GitHub items carry hidden
markers (fingerprint, revision, content signature) in `issues/markers.ts`, so re-runs update, resolve, or reopen items
instead of duplicating them.

- **`issues/`**: one issue per rule (or per finding) whose severity and impact meet the configured bar. Assignable to
  the Copilot coding agent. Issues are resolved when the finding disappears ([details](issues-and-alerts.md)).
- **`fixes/`**: groups autofixes into branches and pull requests, Dependabot-style, with rebase, recreate, close, and
  ignore commands.
- **`alerts/`**: robust statistics on workflow durations: median/MAD z-scores for spikes, and a one-sided Mann-Whitney U
  test for sustained regressions.
  One alert issue per workflow/comparison context, closed only on observed recovery in that context.
- **`telemetry/`**: run snapshots (jobs, steps, queue time, `needs` graph), critical path, and Mermaid Gantt reports.
  Snapshots are stored in memory, in a file (an Actions-cached `.cicd-telemetry` directory), or in Postgres.

### Evidence foundation

Telemetry identity is `(owner, repo, runId, runAttempt)` within one configured GitHub host. Each observed attempt is
retained separately, including failures and cancellations with no completed jobs; saving the same attempt replaces that attempt's current snapshot, not the
other attempts. This is an attempt-preserving store, **not an immutable revision/audit ledger**.
Collectors use the attempt-specific jobs endpoint rather than attaching the latest rerun's jobs to a delayed event.

`TelemetryStore.history({ owner, repo, workflowId, branch, limit })` returns the latest attempt of each run, oldest
first. Latest means greatest attempt number, independent of delivery order or completion timestamp. Selection happens
before workflow/branch/success filtering, so a failed latest attempt does not resurrect an earlier success.
`attempts: "all"` exposes retained attempt evidence; its limit counts attempts, while the default limit counts runs.
An optional `runId` narrows retrieval to one logical run independently of the recent history window.
Baselines and alert series defensively deduplicate retries before selecting successes. An observed event older than a
stored attempt is retained but does not republish a stale performance check or synchronize duration-alert issues.

The file store retains all observed attempts of the newest 200 logical runs per workflow/branch (configurable in its
constructor), using each run's latest attempt to assign its retention group. Eviction removes a whole run. It is still
single-writer; use Postgres for coordinated hosted replicas. Postgres retention, backups and access control remain
operator responsibilities. Migration details are in [GitHub App deployment](github-app.md#telemetry-schema-upgrades).

This telemetry foundation does not itself implement project/task/version topology, runtime technology detection, context-conditioned
duration models beyond the conservative cohorts below, mitigation applications/evaluations, semantic retrieval or cross-organization learning.
The knowledge layers below build on relational evidence and typed relationships, not natural-language summaries treated as facts. Latest-attempt
deduplication prevents retry sample inflation; it does not prove that different workloads, partial reruns or runner
environments are comparable, or that an observed improvement was caused by a mitigation.

### Project declaration evidence (`src/knowledge`)

A separate relational evidence model captures supported project and technology **declarations** at immutable source
revisions. PostgreSQL is the hosted source of truth; the memory adapter supports isolated tests. This is not an
installed-version inventory, task graph, cache-hit measurement, or proof that a tool will improve a build.

`KnowledgeSnapshot` contains a repository identity, source revision, coverage, project nodes, technology evidence and
typed relationships. Repository identity is the authenticated API's stable numeric ID plus canonical GitHub HTTPS host;
owner/repository names are historical aliases. Projects use repository identity, kind and directory, not package names.
Renaming a package/repository preserves the project ID; moving a package intentionally creates a new ID until explicit
lineage is available. Configuration files without a colocated package belong to a distinct configuration-root project,
not to every package beneath the repository.

Each fact records the source path, JSON pointer (or file presence), and SHA-256 of collected source content.
Node/package-manager engines, package-manager pins, Nx/Turborepo/TypeScript/Lerna/Rush dependencies and supported build
tool config filenames are declarations only. Version expressions are not resolved versions. Unsupported expressions,
URLs and local paths are retained as opaque digests, not copied into the knowledge store. Names, paths and safe
declarations still constitute private repository metadata: protect the database and exports accordingly.
Installed `node_modules` manifests/configs are outside this declared-project scope.

Root `package.json` and `pnpm-workspace.yaml` define explicit workspace membership, including exclusions. There is no
fallback that treats all manifests as members because a tool config exists. Simple `workspace:` dependencies can link
by a unique collected workspace name only when discovery is complete, no ignores/truncations are present, and workspace
declarations agree. Duplicate names remain ambiguous; ordinary registry ranges remain unresolved, even if a local
package shares the name. Declared package relationships are never substituted for observed workflow/task dependencies.
The shared workspace/inventory glob matcher uses dynamic programming rather than regex backtracking, with work
proportional to path length times pattern length. Matching consumes the entire path, including unusual trailing newlines.

Coverage is relative to the configured supported inventory, not every technology in the repository. Malformed,
conflicting or unsupported declarations are recorded with sanitized problem codes. Extraction caps relationship and
technology evidence at 10,000 facts and marks omissions explicitly. Truncated/ignored discovery cannot prove local
target uniqueness or tool absence. The default inventory ignores therefore deliberately keep dependency resolution
conservative; explicit membership and positive tool evidence remain available. `technologyStatus` queries only direct
project declarations and returns `observed`, `not-observed`, or `unknown`, never installed/running/beneficial.

Snapshots are content-addressed using canonical evidence plus coverage, source revision and repository aliases;
collection time alone does not create another observation. A repeat preserves the first persisted collection time.
Different coverage or source revisions remain distinct records. Postgres stores normalized snapshots, projects,
technologies and relationships in one transaction with snapshot-scoped foreign keys. Failed writes roll back completely.
Inputs are copied at the persistence boundary, and loaded evidence is checked against its content identity.

`KnowledgeStore.list` requires host and repository ID, a limit of 0-100, and optional revision/project/technology filters.
Combined project/technology filters must match the same project. Reads never silently cross repositories or hosts;
this scoping is not an authorization layer for exposing arbitrary user-supplied IDs. Any future user-facing retrieval
must first establish repository access and authorize source reads before returning declaration payloads. These records
also supply the run-source context below, but project declarations alone do not establish
mitigation outcomes. No causal recommendation, cross-organization learning, vector index or
natural-language SQL interface is inferred from this foundation.

### Run-linked source context

`RunObservation` joins immutable Actions measurements to declaration evidence at the run's reported `headSha`, not
the current branch. The App captures completed deliveries, including failures, cancellations without jobs and delayed
attempts that are correctly withheld from report/alert publication. This does not assert that a checkout actually used
that SHA, or assign workflow/job durations to projects; those claims require execution instrumentation.

With a configured knowledge store, source and runtime evidence are saved in one transaction. The runtime row indexes
host/repository/run/attempt/revision and references the exact source snapshot through a same-host, same-repository,
same-revision composite foreign key. The immutable measurement payload remains JSONB; it is not a task-dependency
table. Concurrent duplicate deliveries preserve the first captured record. Collection timestamps and array ordering
alone do not produce another observation; corrected measurements or changed source coverage remain separate records.
No correction automatically erases or overrules its predecessor.

Source reuse requires a complete declaration snapshot at the same revision with the same versioned inventory-policy
digest (including ignore patterns and collection limits). Partial, malformed or legacy unkeyed observations cannot
satisfy reuse. Runtime collection reads only supported manifest/tool-config blobs, not unrelated workflow or lockfile
contents; normal ignores/limits and whole-tree truncation still apply. Repository identity and a fresh authenticated
[read of the exact source commit](https://docs.github.com/en/rest/commits/commits#get-a-commit) are required before reuse:
metadata access alone cannot authorize historical source contents. Webhook repository IDs protect against names
being reassigned. A source-content 404 produces explicit unknown context without reading cached source; identity/authentication/transient failures
fail processing. Runtime backfill for baseline analytics does not implicitly perform expensive source-tree backfill.

`listRunObservations` is a bounded, scoped **raw evidence** query (0-100 records), optionally narrowed to a run, its
attempt or a source revision. It includes retries and multiple corrections, ordered by observation time; it is not a
latest-attempt selector or a duration baseline. Future statistical consumers must deduplicate logical runs, consider
all retries and contradictory corrections, and apply workload-comparison eligibility before computing
expectations. Matching a project's declaration context does not establish that the project executed or benefited.

### Mitigation evidence

Mitigation definitions are immutable, content-addressed revisions scoped to their source repository. Recipe import
retains explicit rule/file selectors and a digest of the patch; recipe prose, compatibility counters, and undeclared
technologies are not evidence of success. Applications pin a definition and a target repository topology snapshot,
with selected projects and a commit or pull-request reference. Append-only lifecycle events record proposed/applied/
reverted/declined/failed/unknown states. Source timestamps distinguish repeated state occurrences; bounded event reads
return the most recent events, in chronological order. Stable source identity excludes mutable repository aliases.
New definitions and events use identity version 2. Version-1 records remain readable under their original hash rules;
equivalent recipe revisions retain their stored definition ID instead of rewriting existing application references.
These records do not themselves authorize reads from another repository.

Opt-in recipe application/rollout verifies the recipe against its authenticated, commit-pinned published source before
recording a definition and target topology. Returned GitHub PR/issue identities and recipe markers are checked before
recording proposals. Target project attribution remains empty rather than assuming a workflow edit executed every
project. A pinned PR merge is an applied state, not measured success; a changed PR head or completed adaptation issue
is unknown. Persisting App run collection refreshes the latest 100 applications using fresh GitHub state (one request
per distinct change). Invalid configurations, source-inaccessible runs, disabled recipes and nonpersisting previews
do not refresh that history. Failures are explicit and retryable; GitHub writes and database writes are not one transaction.

The `knowledge` CLI exposes bounded application history, explicit lifecycle refresh and caller-selected evaluation.
It resolves authenticated repository identity and checks current contents access before opening storage, then exact
topology revisions before returning applications. Evaluations additionally require fresh reads of every referenced
Actions attempt and source commit. A known database ID is never authorization, and target inspection does not join
source-repository recipe payloads into its response. No free-form SQL or cross-organization recommendation query is exposed.

An evaluation links exact control/treatment run-observation IDs to the application, verifies same-repository scope,
first-attempt eligibility, non-overlapping logical runs, compatible workflow context, application chronology, and
consistent corrections, then recomputes medians and a two-sided Mann–Whitney p-value from both tails. Outcome
direction follows the medians; a significant result with equal medians remains inconclusive. A small p-value is still only
observational evidence: temporal correlation, runner changes, workload shifts not captured by the context key, and
other confounders can violate test assumptions. It is not proof that the mitigation caused an improvement or will
benefit another project. Insufficient samples remain inconclusive; missing evidence can be recorded as unknown.
Evaluations do not establish randomized or otherwise statistically independent runs.

### Operator-controlled evidence lifecycle

Collection remains append-only; explicit maintenance is separate from application/query authorization.
`KnowledgeStore.maintain` previews pruning or erasure by stable host/repository scope. Pruning selects complete logical
run groups using their newest capture, preserves any group referenced by a lifecycle event/evaluation, and removes only
unreferenced old topology. Purging also follows source-definition references into dependent target applications, making
that cross-repository impact explicit rather than breaking foreign keys or leaving orphaned claims.

An application requires the exact digest of a current preview. Postgres recomputes the target identities while holding
write-excluding table locks and applies all related deletes atomically; failures/stale digests change nothing. Preview
transactions are read-only and do not run migrations. Selection caps fail explicitly, never truncate a deletion.
No automatic age, transfer, uninstall or suspension policy triggers writes. Legacy telemetry, webhook payloads and
backups remain separate operator inventories; see the [removal and restore procedure](github-app.md#knowledge-retention-and-removal).

### Reported task execution context

Opt-in `execution capture` measures one explicitly invoked child process, its initial working directory, timestamps,
elapsed time, exit/signal, Git HEAD before execution and the recorder's Node version. It never runs in the App.
Additional installed-tool versions and cache outcomes are supplied by workflow instrumentation with an explicit
`workflow-report` basis. Missing cache observations remain unknown, not misses or hits. A reported Git HEAD does not
prove a clean worktree, prevent the task from changing files/directories, or identify every executed project.

The bounded, allowlisted `ExecutionReport` has repository/run/attempt/revision/job context and single-command coverage.
Authenticated import pins an exact `RunObservation` and numerical Actions job ID, checks the run/attempt/revision,
job interval and logical job key, and freshly authorizes both run and reported checkout revisions. Import never
executes commands or repository code. Storage uses a same-scope run-observation FK and a content-addressed immutable
payload; corrected or conflicting reports remain separate. Queries require fresh Actions/job/Contents access.

This boundary authenticates the **association**, not the supplied report's origin or assertions. Records are always
`operator-supplied`, never automatically attested. [GitHub artifact metadata](https://docs.github.com/en/rest/actions/artifacts#get-an-artifact)
contains run and commit identifiers but no attempt field, so a filename cannot establish attempt provenance.
[Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations) establish provenance
only when verified against policy; even verified provenance does not prove arbitrary cache/performance assertions.
This implementation does not add attestation permissions or require signing routine CI reports.

Reported paths/tools/cache outcomes are not promoted into declaration facts, verified project attribution, duration
cohorts or causal mitigation evidence. They are queryable observations for investigation and future explicit
corroboration. Retention previews include their identities/counts and delete them transactionally with eligible
logical runs; referenced run evidence remains pinned. [Capture/import examples](github-app.md#optional-task-execution-reports).

### Immutable duration evidence

`readRunWindow` provides one consistent, scoped database read of at most 100 logical runs, with the reference run
pinned first. Other runs are ordered by their latest observation time, not claimed to be the latest executions.
Any observation matching the workflow/branch selects its logical run, but **all** stored attempts/corrections of
that run participate, including corrections to the branch/workflow. Filtering first-attempt successes before grouping
would incorrectly resurrect successes hidden by a later failure or correction.

Each group admits at most eight observations of at most 64 KiB each in its adapter's serialized representation
(compact JSON in memory, JSONB text in Postgres). Oversized or truncated groups expose no partial sample; limits do
not discard stored evidence. Postgres performs selection and group loading in one statement with a ten-second
statement timeout. Results distinguish window truncation from incomplete run groups. A complete stored window is
not proof that every Actions run was observed; no knowledge backfill is inferred.

`analyzeDurations` collapses source-context-only variants but rejects any contradictory runtime facts, any observed
retry, incomplete groups, unsuccessful/incompletely collected workloads and mismatched routing/workload contexts.
Future completions are excluded. An ambiguous reference withholds comparisons and budget assessments; a known
newer attempt suppresses stale report publication. Indistinguishable job identities are excluded rather than
merging matrix legs. Each admitted logical run contributes one sample per disambiguated job context.
Collection also rejects names matching multiple workflow definitions, even if the display-name fallback equals a
declared key. Template matching uses bounded literal searches, not backtracking regular expressions. Unknown mappings
cannot satisfy comparison eligibility or job budgets.

The App's knowledge-backed baseline and alert inputs use these eligible immutable observations, not a mutable
correction chosen from the legacy telemetry store. Incomplete groups also hold alert lifecycle changes; known later
runs supplement the existing chronology guard. This deliberately changes cold-store behavior only when knowledge
persistence is configured. Telemetry-only and nonpersisting preview paths preserve legacy baseline/backfill behavior.
The descriptive duration report uses up to 99 prior logical runs; existing baseline/alert window limits still apply
to their own consumers. No budget automatically opens issues, changes a workflow timeout or promotes an experiment.

Versioned analysis policy `immutable-duration-v1` records source observation IDs, exclusions, context, sample count
and window coverage in JSON. R7 p50/p90/p95 and min/max are descriptive, not future time bounds. Configured budgets
have separate definition digests and assessments; they do not alter measurements or quantiles. Missing objectives
remain unconfigured. Current configuration is not a historical objective-application ledger or causal evaluation.
Project execution, installed tool versions, cache behavior and mitigation benefit still require separate evidence.

### Workload comparison contract

Collection records versioned provenance: collector, capture time, whether every job page was collected, and whether
the jobs could be mapped to workflow definitions at that run's source revision. Backfill retrieves each historical
definition at its own `headSha`; it never rewrites historical dependencies using the current workflow. Missing job
arrays fail explicitly; truncated, inconsistent or duplicate pagination is not certified complete.

The comparison policy in `telemetry/context.ts` admits only successful **first attempts**, with complete collection,
known job definitions, successful observed jobs and nonempty runner labels. Legacy snapshots remain available as
evidence but cannot establish a new comparison until recollected with provenance. Retries can be partial or warmed;
even successful retries are excluded, after latest-attempt selection, rather than resurrecting their older successes.

A versioned deterministic key groups repository/workflow/branch/trigger, executed job keys and display names
(including matrix legs), dependency relationships, runner label sets and observed runner-group IDs. Job/label
ordering, ephemeral runner names and job IDs do not change it. Source SHAs remain provenance, **not** a grouping
criterion: otherwise every commit would erase the history needed to detect regressions. Exact label equality is
only an observed-context guard, not proof of identical hardware, tool versions, cache state or work volume.

Reports and alert series use these groups. Hosted history scans at least the latest 200 logical runs (more if the
configured comparison window requires it), filters comparable evidence, then limits samples. A cold eligible group
can backfill up to the requested history window, subject to the Actions API's 100-run page limit. This is bounded
retrieval, not a claim that no comparable evidence exists anywhere. Ineligible observations do not synchronize alert
issues. Missing tracked series never count as recovery.
Baseline queries exclude completions newer than their reference run. When a later run of the same workflow/branch
is already observed, an older delivery may produce its historical report but cannot advance the alert lifecycle,
even if that later run belongs to a different workload context.

Workflow queue time for newly collected retries is `null`, not zero or the elapsed time since the original run was
created. Known queue measurements alone contribute to the queue median; an entirely unknown median is also `null`.
Postgres initialization relaxes the old `queue_ms NOT NULL` constraint transactionally without rewriting existing
observations. Reports suppress legacy retry queue values that may include inter-attempt waiting.

## Hill climbing (`src/experiments`)

Deterministic machinery for the [gh-aw experiment loop](experiments.md). It covers the manifest and rubric validation
(`manifest.ts`, `propose.ts`), measurement collection from CI and corpus evaluation in isolated worktrees (`collect.ts`,
`evaluate.ts`, `corpus.ts`), statistics (`score.ts`, a one-sided Mann-Whitney U test), and the
promote/reject/expire/wait decision (`decide.ts`). Agents propose, implement, and judge. This code decides.

## Recipes (`src/recipes`)

These turn a promoted pipeline experiment into a portable [recipe](recipes.md). The flow is `apply.ts` (autofix PR,
partial, or adaptation issue), then `compat.ts` (Wilson-bounded CI compatibility), then `rollout.ts` (canary-first,
compatibility-gated waves).

## Trust boundaries

- **Linting is static.** No repository code runs in the CLI, Action, or App, so untrusted pull requests can't reach
  their credentials. The only place untrusted code runs is the grader's token-less evaluation step.
- **Least-privilege writes.** The App requests only the permissions in `app.yml`. Workflows set minimal top-level
  permissions (`{}` or read-only) and grant write scopes per job. Agentic workflows never hold write tokens; gh-aw safe outputs apply
  validated requests.
- **Humans stay in the loop.** Fix, recipe, and experiment trunk pull requests need review unless a repository opts in to
  auto-merge.