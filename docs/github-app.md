# Running the GitHub App

The App is the Dependabot-style, zero-workflow way to run CI/CD Optimizer across an organization. It reacts to webhooks
with the same service layer the [Action and CLI](../README.md#three-ways-to-run-it) use, so behavior and configuration
(`.github/ci-cd-optimizer.yml`) are identical. Use the App when you want installation-wide coverage without adding
workflows to every repository.

## What it does

| Webhook | Handler |
|---|---|
| `pull_request` opened, synchronize, reopened, ready_for_review | Runs the **CI/CD Optimizer** check. It annotates only findings the pull request introduces, compared with the base. |
| `check_run` rerequested | Re-runs that check. |
| `push` to the default branch that touches CI/CD files, or has 20+ commits | **Repository scan:** uploads SARIF to code scanning and syncs [finding issues and fix pull requests](issues-and-alerts.md). |
| `installation` created, `installation_repositories` added | Initial scan of each newly covered repository. |
| `workflow_run` completed | Records a telemetry snapshot. Posts the **CI/CD Telemetry (\<workflow\>)** check with the Gantt chart and bottlenecks, and syncs [duration alerts](issues-and-alerts.md#duration-alerts). |
| `issue_comment` created | `@cicd-optimizer` [commands](configuration.md#fix-pull-requests-fixes) on the App's fix and recipe pull requests, from users with current repository write, maintain, or admin permission. |

GitHub delivers installation events to every App, so they aren't listed in `default_events`.

## Register the App

[app.yml](../app.yml) is a [GitHub App manifest](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
with the minimum permissions:

| Permission | Access | Why |
|---|---|---|
| Actions | read | Workflow runs, and job and step timings for telemetry and alerts. |
| Checks | write | Pull request check and telemetry reports. |
| Contents | write | Read workflows and manifests; push fix pull request branches. |
| Issues | write | Finding and duration-alert issues. |
| Metadata | read | Required; also reads current repository permissions before accepting comment commands. |
| Pull requests | write | Fix and recipe pull requests and their commands. |
| Security events | write | SARIF upload to code scanning. |
| Workflows | write | Fix pull requests that edit `.github/workflows/**`. |

The fastest path uses Probot's manifest flow:

1. Set the webhook and setup URLs in `app.yml` to your deployment, replacing the `example.com` placeholders.
2. Run `npm ci && npm run build && npm start` with no `APP_ID`.
3. Open <http://localhost:3000> and register the App. Probot writes its credentials to `.env`.

You can also create the App manually under **Settings → Developer settings → GitHub Apps** with the permissions and
events above. The webhook path is `/api/github/webhooks`. For Actions-only use without hosting, the
[setup checklist](setup.md#3-github-app-owner) has a prefilled registration link.

## Configure

| Variable | Required | Purpose |
|---|---|---|
| `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` | yes | App credentials ([.env.example](../.env.example)). |
| `HOST`, `PORT`, `LOG_LEVEL` | no | Bind address, HTTP port (default 3000), and log level. Probot defaults to `localhost`; the container sets `HOST=0.0.0.0` so published ports and ingress can reach it. |
| `DATABASE_URL` | when queue mode is `postgres` | Postgres connection for durable webhook jobs, telemetry history and revision-linked project declaration evidence. In direct mode it remains optional; without it, telemetry history comes from the Actions API and knowledge is not persisted. Tables are created on first use. |
| `WEBHOOK_QUEUE` | no | `direct` (compatibility default) runs handlers in the HTTP request. Set `postgres` for durable hosted processing; requires `DATABASE_URL`. Unknown values fail startup. |
| `COPILOT_ASSIGN_TOKEN` | no | Token for a Copilot-licensed user, used to [assign issues to the Copilot coding agent](issues-and-alerts.md#assigning-issues-to-the-copilot-coding-agent). App installation tokens can't assign Copilot. Without this token, issues get the `copilot:ready` label instead. |
| `CICD_OPTIMIZER_UPLOAD_SARIF` | no | Set to `false` to skip code scanning uploads. Uploads fail softly when code scanning is unavailable, for example on private repositories without GitHub Advanced Security. |

With `NODE_ENV=production`, startup rejects missing or blank webhook secrets and the placeholders `development` and
`replace-me`. Use a unique secret matching the App's webhook settings. Never expose a development-mode server publicly.

### Project knowledge collection

When `DATABASE_URL` is configured, enabled push/installation repository scans save [revision-linked declaration
evidence](architecture.md#project-declaration-evidence-srcknowledge) before publishing GitHub findings. The App creates
`knowledge_snapshots`, `knowledge_projects`, `knowledge_technologies`, and `knowledge_relationships` transactionally on
first eligible scan. Initialization is serialized across replicas. Initialization/save failures fail the scan instead
of silently reporting durable learning; failed initialization closes its pool and permits a later retry. Durable
queue mode retries processing; direct mode requires redelivery. Disabled/invalid repository configurations do not
initialize knowledge persistence. No additional GitHub permission is required.

For a non-persisting preview, run `ci-cd-optimizer scan --knowledge --dry-run --format json`. CLI/Action `scan` does not
implicitly use `DATABASE_URL`; `--knowledge` adds evidence to output only. Dry runs never initialize or save a knowledge
store. Without `--dry-run`, the scan's normal configured GitHub issue/fix behavior still applies.

Completed workflow deliveries also capture immutable run/attempt observations linked to source declarations at the
run-recorded SHA. `knowledge_run_observations` and a scoped source-reference index are added transactionally under the
same schema lock; existing declaration snapshots remain intact. Source and runtime writes roll back together. Source
content unavailable with HTTP 404 is retained as unknown context; other collection or persistence failures fail the
delivery. Invalid configuration skips knowledge explicitly without initializing its store.

Use `ci-cd-optimizer telemetry --run-id <id> --knowledge --dry-run --format json` for a non-persisting runtime/source
preview (requires Contents read as well as Actions read). Repeated runs at one revision reuse only complete source
evidence collected under the same ignore/limit policy, after rechecking repository identity and current commit-read
access. Metadata access alone never unlocks cached source evidence. Reports distinguish source
declarations from actual project execution. Runtime source backfill, project/task attribution, installed tool/cache
telemetry and learned mitigation evaluation are not inferred from these links.

The evidence tables are append-only observations, not a retention policy or audit-grade tamper-proof ledger. Operators
must configure backups, database access, capacity, deletion/retention procedures and repository-removal policy before
production rollout. No knowledge API, learned mitigation recommender, or automatic deletion on uninstall is enabled.
Default inventory ignores and extraction limits remain visible in every record; do not interpret missing evidence as
proof that a project does not use a tool.

## Deploy

The [Dockerfile](../Dockerfile) builds a distroless, non-root Node 22 image. The production dependency layer is cached
separately from the TypeScript build. The [Container workflow](../.github/workflows/container.yml) builds the image on
every push to `main` and every `v*` tag. Set the repository variable `GHCR_IMAGE` (for example
`ghcr.io/my-org/ci-cd-optimizer`) to push it to GitHub Container Registry. Images are tagged with the commit SHA and
with `main` or the release tag (such as `v0.2.0`), and labeled so the package is linked to the repository.

```sh
docker run -p 3000:3000 --env-file .env ghcr.io/my-org/ci-cd-optimizer:<sha>
```

Run it on any container host with a public HTTPS endpoint, such as Azure Container Apps, Kubernetes, or Cloud Run. The
process is stateless apart from the optional Postgres database. `GET /ping` returns `200 PONG` for an HTTP liveness
probe; it does not verify credentials, installation access, database availability, or GitHub connectivity.

### Production-image verification

CI runs `test/service/container-smoke.mjs` against the actual image in both direct and Postgres modes. Each run
creates an internal Docker network, uses ephemeral test keys, and binds a synthetic
GitHub HTTP API only to that network's host gateway. Startup health is first checked through a published loopback
port; the external bridge is then disconnected and internal-only attachment is asserted before any webhook or
authentication scenarios. Those scenarios have no outbound internet. The normal Probot transport verifies JWT signing and
installation-token exchange, token reuse and installation isolation, base-commit policy reads, PR analysis, and
authenticated publication of the expected job-timeout finding. Invalid or missing webhook signatures must trigger
neither API calls nor durable inserts.

The smoke test also refuses one installation's token request, restores access, and verifies direct redelivery or
durable worker retry. A completed durable redelivery must not duplicate its check. It advances only the synthetic
failed job's availability to avoid waiting through backoff; retry timing is covered separately by queue tests.
Non-root/read-only operation, published-port health and graceful shutdown remain checked.

Postgres mode also stalls a claimed worker immediately before the synthetic API creates a check. Duplicate ingress
and another same-scope delivery must remain accepted without bypassing that job, while an independent scope completes.
The test kills the App process with SIGKILL, verifies that both pending jobs survive, then replaces the container
against the same database on the internal-only network. The fresh process must authenticate again, finish both jobs in
FIFO order, clear their stored payloads, and deduplicate completed redeliveries. This crash boundary is **before the
remote write**, not a claim of exactly-once effects when a crash occurs after GitHub has already accepted a write.
The real test database is also paused beyond the persistence deadline. Ingress must fail with HTTP 503, not
acknowledge unstored work with HTTP 200/202. After the database resumes, the pending operation may commit late;
its analysis must complete and subsequent redelivery must be deduplicated.

The durable smoke test requires `SMOKE_DATABASE_URL` and `SMOKE_DATABASE_CONTAINER` for a disposable test Postgres
container, as supplied by CI. It temporarily attaches that container to its isolated network and changes test-job
state. **Do not point it at a production database.** The App container, temporary network, database network attachment
and local API are cleaned up after each run; CI owns disposal of the test database.

These checks use synthetic credentials and API responses. They do not establish a real GitHub App installation,
granted permissions, public HTTPS/TLS, or live delivery and write access; validate those against the deployed App.

### Telemetry schema upgrades

The attempt-preserving store migrates `workflow_run_snapshots` from a run-only primary key to
`(owner, repo, run_id, run_attempt)`. Existing rows and their recorded attempt numbers are preserved. Previously
overwritten attempts cannot be recovered by this migration; ordinary Actions history backfill observes the attempts
returned by GitHub, not every historical retry.

**Stop all old App replicas and independent telemetry writers before upgrading.** Back up the database, deploy the new
version to every writer, and then resume processing. Old binaries use a run-only conflict target and are incompatible
with the new key; this is not a mixed-version rolling upgrade or an automatically reversible downgrade.
Initialization serializes migrations with a transaction-scoped advisory lock, validates the existing key, and changes
it atomically. Repeated/concurrent initialization by the new version is supported. Unexpected keys or external
dependencies fail explicitly without dropping data. DDL has a ten-second lock timeout and a sixty-second statement
timeout; a large or busy database may require a separately planned maintenance migration rather than repeated startup
retries. Keep all writers in one database/schema for one GitHub host; owner/repository names are not cross-host IDs or
permanent identities across renames/transfers.

The same-attempt save operation can correct its snapshot and indexed metadata, but does not record correction history.
Initialization also makes `queue_ms` nullable for unknown retry queue measurements, including databases already using
the attempt-level key. Old observations are not rewritten. Newly collected snapshots carry comparison provenance;
older snapshots remain stored but are ineligible for context-scoped performance comparisons until recollected.
Retaining attempts does not establish an immutable knowledge ledger or causal proof of an optimization. See the
[evidence model boundary](architecture.md#evidence-foundation).

### Durable hosted processing

Set `WEBHOOK_QUEUE=postgres` and point every replica at the **same database and schema**. Probot verifies the webhook
signature before the App stores the delivery, and the HTTP request succeeds only after that transaction commits.
Analysis then runs in two background workers per process rather than consuming GitHub's webhook response deadline.
If persistence fails, GitHub receives a failed delivery; it does not automatically redeliver it.

Durable mode uses a dedicated HTTP transport while retaining Probot's signature verification and event dispatch.
It returns HTTP 503 if body receipt, verification and persistence do not finish within five seconds, leaving margin
before GitHub's ten-second deadline. It never uses the default Probot transport's early HTTP 202 response.
Payloads are bounded to 25 MiB, including chunked requests; invalid signatures and malformed requests are rejected
before enqueue. `WEBHOOK_PATH`, `HOST`, `PORT`, `/ping`, and SIGTERM/SIGINT shutdown remain supported.
Direct mode retains Probot's existing transport and setup flow. Probot's development `WEBHOOK_PROXY_URL` is supported
only in direct mode; durable mode rejects it explicitly and requires an endpoint reachable by the webhook sender.

A failed response or disconnected client does not cancel a database operation already in progress: the commit outcome
can be unknown, and the operation may finish after the deadline. Late success/failure is logged. Redeliver using the
original delivery ID after resolving the outage; pending/completed delivery deduplication covers a late commit.
Do not treat HTTP 503 as proof that no job exists, or create a new delivery ID merely to retry it.

Postgres transaction locks serialize repository mutations across workers and replicas. PR checks use a separate scope
so a long repository scan does not block them. Installation events are split into per-repository jobs and inserted
atomically in a batch, so one failed repository does not force successful repositories to run again. Pending and
completed redeliveries are deduplicated by delivery ID and scope.

Failed jobs retry up to five attempts, with exponential delays starting at 30 seconds and capped at 15 minutes.
A delayed retry blocks later jobs in its scope, but not other repositories or the separate check scope. Exhausted
jobs become `failed` and produce an error log. After resolving the cause, redeliver the original event from the App's
**Advanced > Recent deliveries** to reset only its failed jobs; completed jobs stay completed.

Worker transactions roll back when a worker process dies, leaving the job available for another worker. SIGTERM stops
HTTP ingress and drains active workers before closing the database. Configure the host's termination grace period for
the expected job duration; a forced exit instead relies on transactional recovery. Do not set a database
`idle_in_transaction_session_timeout` shorter than a job: workers hold a transaction while calling GitHub.
Attempt counts commit with the handler's result; a process crash rolls back that attempt, so the five-attempt
failure limit does not bound repeated process crashes. Monitor restarts as well as failed-job logs.

This is **at-least-once**, not exactly-once, processing. A crash or lost database connection after a GitHub write but
before committing completion can replay that write. GitHub writes cannot be rolled back with the database transaction,
and a lost lock cannot fence an already-issued GitHub request. Comments or partially completed operations may need
manual reconciliation. Coordinate all App replicas through the same database, and do not run independent write-enabled
Action/CLI scans concurrently with them.

Fix and recipe scans also recover a PR created before its labeling request succeeded, including when the create
response was lost. They query GitHub directly by the configured group branch and base, validate the same-repository
head and fix marker, and then use the normal planner. An unchanged PR gets only missing metadata; human commits
still prevent rebuilding, and closing an unlabeled PR still declines that change. A conflicting open PR is an explicit
error before any branch write. Discovery fails closed at 1,000 PRs for one group branch rather than planning from
an incomplete history. Keep the original group and branch prefix configured until a partial creation is reconciled.

New PRs record pending reviewer setup in their fix marker. Retrying restores missing labels and finishes that setup
without rebuilding the branch, skipping users/teams whose review requests are still pending. Removed configuration
entries are not requested on retry. Draft PRs defer reviewer setup until a fix/recipe scan after they become ready.
GitHub reviewer errors (including 422) now fail explicitly instead of being ignored; correct the reviewer configuration
before redelivery. A review completed between
the original request and recovery can still be requested again: this is not an exactly-once notification guarantee.
Older PRs created without the pending-reviewer marker cannot retroactively recover a lost reviewer request.
Creation refuses an existing branch unless its tip matches a recorded bot commit from a closed PR in that group, and
never force-pushes a ref that appeared after a missing-ref preflight. A branch-only write made before PR creation
therefore requires operator reconciliation rather than an unsafe overwrite. Comment replays and other partial
operations can still require reconciliation; the queue is not a transaction across GitHub and Postgres.

Rebuilding an existing fix/recipe branch, or reusing an unchanged branch from a closed PR, uses GitHub GraphQL
`updateRefs` with `beforeOid`. GitHub atomically rejects the update if the ref no longer matches the observed head,
including when a human pushes after planning; there is no unconditional-write fallback. An explicit `recreate` may
replace edits already observed, but not a later concurrent push. Updates keep an existing PR's actual head branch
when the configured prefix changes. Missing ownership/head evidence protects the PR from automatic rebuild/closure,
and labeled fork PRs are not treated as writable local branches. GitHub Enterprise deployments must support
`updateRefs`; the App adapter uses the Enterprise `/api/graphql` endpoint.

Closed history is verified against PR details too; labels or commit markers alone do not prove local branch
ownership. Reuse requires the same repository, exact head branch and commit, intended base, closed state and
reconciled update/cleanup intents. The App checks again after building the commit and before writing the ref,
including whether another open PR now uses that branch. Lookup failures are not treated as missing branches.
Discovery details are reused to avoid redundant per-PR requests; history not returned by those queries requires
an individual lookup. These metadata checks are preflight checks, not atomic locks against later PR-state changes.

Existing PR updates first persist their intended commit, signature, base, rules and rendered description in the PR,
with a visible **Update pending** notice. The old committed marker stays in place until the expected-head ref write
finishes. A retry recognizes the exact intended head and finalizes only the marker, preserving the staged recipe
revision and subsequent body edits; it does not create another commit. A completed intent also satisfies a retried
rebase/recreate on the same base and signature. Closed PRs with pending intents are reconciled too, so a decline
after a successful write is not mistaken for a different change.

If the intended head was never applied, recovery discards that intent and the normal planner rebuilds from current
policy and base contents, not stale saved files. A different human head remains protected and gets an **Update
interrupted** notice rather than a branch write. Recovery is a `metadata` action with `recoverUpdate: true`, including
in scan dry-run output. An incomplete intent or changed state/marker fails explicitly for reconciliation/retry.
PR body and head are read together; preparation is rechecked before writing the ref. Normal rebuilds replace the
bot-authored section between hidden `fix-body-start`/`fix-body-end` boundaries, retaining notes outside it. For older
bodies without those boundaries, notes after the unchanged Commands block are carried forward. Keep inline review
discussion in review comments or outside the generated section. A retry that only finalizes a marker preserves the
whole current body, including edits inside the generated section.

PR metadata and refs are still separate GitHub operations, not a transaction: the pending description can precede
the branch write, and simultaneous body edits between a read and PATCH cannot be conditionally locked. Keep all
writers coordinated as above. Pre-existing interrupted updates without intent markers still need operator
reconciliation, and replayed comments/commands after their completion is fully recorded are not exactly-once.

Every conditional existing-ref write (fix/recipe rebuild or reuse, experiment promotion, and cleanup) rereads
repository metadata and requires a nonempty repository node ID and default branch. Both updates and deletions
refuse the observed default branch, even when its head still matches the planned commit. Missing or malformed
metadata fails before the ref mutation; there is no unconditional fallback. A blocked write may leave a prepared
fix/recipe intent or an already-merged experiment arm, so use the corresponding recovery or reconciliation path.
This repository-metadata check is preflight, not an atomic lock against a later default-branch change. Keep default
branches protected with GitHub rules and coordinate repository-setting changes with automated writers.

Fix/recipe closure records the cleanup branch and observed head in the same PR update that closes it. Cleanup uses
an atomic zero-OID `updateRefs` mutation with that original head, never unconditional REST deletion. Missing refs
are reported as absent; changed heads, branches used by another open PR, and reopened PRs are retained with a visible
outcome in the PR body. Permission, validation and transport errors propagate instead of being treated as deletion.
A lost deletion response is reconciled by observing the ref on retry, without adopting a newer head.

Pending cleanup is recovered even on closed PRs and appears as a `metadata` action with `cleanup: true` in scan
dry-run output. Terminal outcomes are recorded so replaying an old close command cannot delete a later recreated
branch. A closed legacy PR without a cleanup intent is not permission to delete its branch. A reopened PR with
cleanup history is held (`reopened` skip reason), rather than immediately closed again by a retry. For normal fix
PRs, an explicit rebase/recreate resumes updates, or a new close command records a new cleanup target. Reopened
recipe PRs require manual reconciliation; rollout does not override that hold. Keep pending cleanup markers intact
until recovery or manual reconciliation completes.

Experiment cleanup also checks the originally observed head and same-repository ownership, recording preservation
in grading notes when evidence differs. Its broader promotion/closure sequence is not covered by the fix/recipe
cleanup marker protocol; interrupted grading may still need manual reconciliation. All cleanup refuses base/default
branch deletion. Ref deletion, PR state and other PR creation are not a single GitHub transaction; keep writers
coordinated, and treat cleanup as reference management, not a guarantee that Git objects have been erased.
Open-PR checks are preflight checks, not locks against later reopening or reuse. If a ref is deleted and recreated
at the identical recorded SHA before its terminal cleanup outcome is stored, GitHub cannot distinguish the new
ref from the original; pending cleanup can delete it. Finish or manually reconcile pending cleanup before reusing
that branch name, even if the replacement points to the same commit.
Experiment promotion, rejection and expiry bind collected evidence to PR identities and commit SHAs. Promotion
confirms the winner merge and defers arm cleanup until its ref and PR metadata are verified. All experiment
closures verify fresh ownership and identity before writing, then read back the closed state before cleanup or
success reporting; see [experiment safeguards](experiments.md#3-grader-daily-experiment-gradermd).

Monitor queue age and failed jobs in addition to `/ping` and process health:

```sql
SELECT status, count(*), min(received_at) AS oldest_received
FROM webhook_jobs GROUP BY status;

SELECT delivery_id, scope, attempts, last_error
FROM webhook_jobs WHERE status = 'failed' ORDER BY received_at;
```

Completed payloads are cleared, while delivery IDs remain for deduplication. Pending/failed payloads contain repository
and comment data; protect the database with appropriate access controls, encryption, backups, and a retention policy.
Deleting completed rows also ends their deduplication window. Database provisioning and monitoring are deployment
responsibilities; selecting this mode does not create a hosted database.

### Direct mode and verification

Within one App instance, repository scans (push and installation events), telemetry updates, and fix/recipe commands
share a case-insensitive, per-repository FIFO queue. The queue covers both reading current managed items and applying
the resulting changes, so overlapping deliveries cannot both reconcile against the same pre-write state. A failed
operation still fails its delivery but releases the next operation. Different repositories and independent PR checks
can run concurrently.

In `WEBHOOK_QUEUE=direct`, that queue is in memory: it does not survive a restart or suppress repeated delivery IDs.
Waiting and analysis both count toward webhook response time. Use direct mode for local development or limited
single-instance deployments; use Postgres mode when restart recovery or multiple replicas are required. In direct mode,
an installation delivery attempts every repository and fails if any scan throws.

CI exercises signed HTTP delivery, simulated installation authentication and GitHub writes, concurrent handlers, and
permission checks. Real-Postgres tests cover durable acknowledgement, deduplication, worker coordination, retry/dead-letter
behavior, and recovery after killing a worker process. The `app` job builds the production image and exercises both
direct and Postgres modes through a published port, including completion by the image's actual background worker.
These checks use ephemeral credentials and do **not** register or install a real GitHub App.

Before declaring a deployment production-ready, verify a real installation-token exchange, webhook delivery to the
HTTPS endpoint, a controlled finding issue and workflow fix PR, the PR's CI run, and telemetry on the intended repository.
Also test restart/redelivery behavior on the chosen host. A published GHCR image or a zero-findings scan is not evidence
that these write paths work with the live App's permissions.

## App, Action, or both?

| Need | Use |
|---|---|
| Org-wide coverage with no per-repository setup, plus telemetry for every workflow | The App. |
| A required status check with SARIF in workflows you control, or no hosting | The Action ([examples](../examples/workflows)). |
| Hill-climbing experiments and recipe rollout | Workflows in this repository. The rollout uses the App's credentials to reach target repositories ([recipes](recipes.md#setup)). |

The App and `command: scan` share identifiers: issues are matched by hidden fingerprints, fix pull requests by branch,
and code scanning alerts by their fingerprints. Sequential scans therefore update existing items. This is not a
distributed lock or an exactly-once delivery guarantee. Postgres mode coordinates participating App workers, but not
independent Actions or CLI processes. Avoid overlapping write-enabled scans from those surfaces; simultaneous first
scans that do not share coordination can still race to create items.
