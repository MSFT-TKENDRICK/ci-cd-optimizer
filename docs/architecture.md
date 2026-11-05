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
  One alert issue per workflow, closed on recovery.
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

This foundation does not yet implement project/task/version topology, technology detection, context-conditioned
duration models, mitigation applications/evaluations, semantic retrieval or cross-organization learning. Those should
build on relational evidence and typed relationships, not natural-language summaries treated as facts. Latest-attempt
deduplication prevents retry sample inflation; it does not prove that different workloads, partial reruns or runner
environments are comparable, or that an observed improvement was caused by a mitigation.

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