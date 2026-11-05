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
 core                       lint/  (engine · config · parsers · project model · 33 rules · formatters)
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
   expressions. There are 33 rules in 8 rulesets: `workflow`, `checkout`, `affected`, `caching`, `hermeticity`,
   `containers`, `packages`, and `registries` ([catalog](rules.md)).
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
duration models beyond the conservative cohorts below, mitigation applications/evaluations, semantic retrieval or cross-organization learning. Those should
build on relational evidence and typed relationships, not natural-language summaries treated as facts. Latest-attempt
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
must first establish repository access. These records are not yet joined to runtime observations or mitigation
applications/evaluations; no causal recommendation, cross-organization learning, vector index or natural-language SQL
interface is inferred from this foundation.

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