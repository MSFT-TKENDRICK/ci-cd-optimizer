# CI/CD Optimizer

CI/CD Optimizer is Dependabot for build and release performance. It lints GitHub Actions workflows, Dockerfiles,
Nix expressions and flakes, and package/toolchain configuration for declared build practices and potential improvements:
hermeticity, caching, dependency layers,
sparse checkout, affected-only testing, GHCR and GitHub Packages, and package decomposition. It then acts on the
findings the way GitHub Advanced Security and Dependabot do. It also measures configured Actions workflows, flags
potential slowdowns using statistical thresholds, and runs hill-climbing experiments with GitHub Agentic Workflows to evolve its own rules and
your pipelines.

It is tuned for agentic development, where many small, agent-authored changes make CI latency the bottleneck.
Developer agents can use the [canonical plugin and skills, local MCP/ACP, or opt-in authenticated hosted ACP](docs/agents.md)
to inspect findings and exact fix previews without executing repository code or receiving write APIs.

One rule engine runs behind every entry point: a standalone linter, a CLI, a GitHub Action and reusable workflow, git
hooks, a self-hosted GitHub App, and an [OSS-Fuzz](https://github.com/google/oss-fuzz)-style review program that
reviews other projects' CI/CD from a pull request and publishes signed daily reports.

| Familiar tool | CI/CD Optimizer equivalent |
|---|---|
| Code scanning alerts | Lint findings uploaded as SARIF under **Security › Code scanning** |
| Dependabot alerts → issues | Severity-gated finding issues, deduplicated and auto-closed, assignable to the Copilot coding agent |
| Dependabot version updates | Grouped autofix pull requests with `@cicd-optimizer rebase / recreate / ignore` commands |
| Dependabot compatibility score | Recipes: promoted experiment fixes rolled out to other repos in waves gated by CI pass rate |
| actionlint, hadolint, zizmor | `cicd-lint`: path and stdin input, `--base` diffs, autofix, SARIF, inline suppressions, local rules |
| OSS-Fuzz project onboarding | [Review program](#reviewing-other-projects-oss-fuzz-style): register a public repository by pull request; daily re-reviews with Sigstore-signed reports |
| — | Duration alerts: robust z-score spikes and Mann-Whitney step regressions per workflow and job |
| — | Telemetry reports: Gantt timeline, job dependency graph, critical path, slowest steps, and bounded log-backed bottleneck evidence with coverage gaps |

- [Ways to use it](#ways-to-use-it)
- [Scanning pull requests](#scanning-pull-requests)
- [Reviewing other projects, OSS-Fuzz style](#reviewing-other-projects-oss-fuzz-style)
- [What it finds](#what-it-finds)
- [Acting on findings](#acting-on-findings)
- [Hill climbing](#hill-climbing-with-github-agentic-workflows) and [recipes](#recipes-reusing-a-winning-fix-elsewhere)
- [Formal guarantees and their limits](#formal-guarantees-and-their-limits)
- [Evidence-backed project history](#evidence-backed-project-history)
- [Versions and pinning](#versions-and-pinning)
- [Project status](#project-status)
- [Tokens and permissions](#tokens-and-permissions)
- [Development](#development)

<a id="three-ways-to-run-it"></a>

## Ways to use it

| Entry point | What you get | Start with | Docs |
|---|---|---|---|
| **Developer-agent plugin** | Canonical optimization/triage/run-analysis skills and a bundled read-only MCP server | [Install the plugin](docs/agents.md#canonical-plugin-and-skills); Node.js 22+, no build needed | [agents.md](docs/agents.md) |
| **MCP / ACP** | Local workspace tools/commands and exact previews; opt-in GitHub reads and authenticated hosted ACP | `cicd-mcp --root <workspace>`, `cicd-acp`, or [hosted configuration](docs/agents.md#hosted-acp-on-your-own-app-deployment) | [agents.md](docs/agents.md) |
| **`cicd-lint`** | Offline linter for a checkout: paths, globs, stdin, `--base` diffs, `--fix`, SARIF, suppressions, local rules | `cicd-lint` after [installing the CLI](#install-the-cli) | [linter.md](docs/linter.md) |
| **`ci-cd-optimizer` CLI** | Every command in the [table below](#cli-commands), from a terminal or any CI system | `ci-cd-optimizer <command>`, or `npm run cli -- <command>` in a clone | `ci-cd-optimizer help <command>` |
| **GitHub Action** | Any CLI command as a workflow step, selected with `command:` (default `lint`) | `uses: MSFT-TKENDRICK/ci-cd-optimizer@<full commit SHA>` | [action.yml](action.yml), [examples](examples/workflows/) |
| **Reusable workflow** | A lint job that needs only `contents: read` and uploads SARIF as an artifact | `uses: MSFT-TKENDRICK/ci-cd-optimizer/.github/workflows/lint-reusable.yml@<SHA>` | [linter.md › CI](docs/linter.md#ci) |
| **Git hooks** | `cicd-lint` before each commit with pre-commit, lefthook, or husky | the `cicd-lint` hook in [`.pre-commit-hooks.yaml`](.pre-commit-hooks.yaml) | [linter.md › Git hooks](docs/linter.md#git-hooks) |
| **Scheduled scan** | The Dependabot-style pass with no hosting: SARIF, finding issues, fix pull requests | [cicd-optimizer-scan.yml](examples/workflows/cicd-optimizer-scan.yml) | [issues-and-alerts.md](docs/issues-and-alerts.md) |
| **Run telemetry** | After each workflow run: a Gantt chart, critical path, slowest steps, bounded log-backed bottleneck evidence with coverage gaps, and duration alerts | [cicd-optimizer-telemetry.yml](examples/workflows/cicd-optimizer-telemetry.yml) | [duration alerts](docs/issues-and-alerts.md#duration-alerts) |
| **GitHub App** | Self-hosted Probot service: pull request checks, scans, telemetry, and `@cicd-optimizer` commands, with no workflows in target repositories | the [Dockerfile](Dockerfile) image, or `npm start` | [github-app.md](docs/github-app.md) |
| **Guided setup** | Registers and installs the App, stores its credentials, and authorizes Copilot coding agent handoff, in a browser or as an MCP App panel in chat | `npm run setup -- --repo OWNER/REPOSITORY` | [setup.md](docs/setup.md#3-github-app-owner) |
| **Review program** | OSS-Fuzz-style registration of a public repository, an intake review on the pull request, and signed daily re-reviews | a pull request that adds `projects/<name>/project.yaml` | [review program](docs/review-program/README.md) |
| **Experiments and recipes** | Agentic hill climbing on rules and pipelines, and wave rollout of winning fixes to other repositories | the workflows in [.github/workflows](.github/workflows/) | [experiments.md](docs/experiments.md), [recipes.md](docs/recipes.md) |

There is no public hosted App and the package is not published to npm. Run the App on your own infrastructure, and
install the CLI from a clone.

### Install the CLI

Requires Node.js 22 or later.

```sh
git clone https://github.com/MSFT-TKENDRICK/ci-cd-optimizer
cd ci-cd-optimizer
npm ci && npm run build
npm link                     # puts cicd-lint, ci-cd-optimizer, cicd-mcp, and cicd-acp on PATH

cd ~/src/my-service
cicd-lint                    # lint the current directory; exits 1 on errors
cicd-lint --base origin/main # only findings this change introduces
cicd-lint --fix              # apply available autofixes; review and test the resulting diff
cicd-lint --init             # write a starter .github/ci-cd-optimizer.yml
cicd-lint -f sarif -o cicd.sarif
```

`cicd-lint [args]` is shorthand for `ci-cd-optimizer lint [args]`. `npm pack` in the clone builds an installable
tarball. Inside the clone, `npm run cli -- <command>` runs the TypeScript sources without building.

### CLI commands

| Command | Purpose | Needs |
|---|---|---|
| `lint [paths...]` | Lint workflows, Dockerfiles, Nix expressions/flakes, and package/toolchain configuration. The default command. | A checkout |
| `rules` | List the rule catalog (`--format json\|markdown`) | — |
| `scan` | Lint a repository's default branch through the API like the App, then upload SARIF (`--upload-sarif`), sync finding issues, and open fix pull requests. `--dry-run` previews. | `--repo`, a token |
| `ssdf` | Report repository-visible evidence against all 42 NIST SP 800-218 SSDF v1.1 tasks (`--format json` for machine-readable output; `--repo owner/name` reads a remote repository). Not a compliance determination. | A checkout, or a token for a remote repository |
| `telemetry` | Report on a completed workflow run (`--run-id`) with a Gantt chart, critical path, and bounded log-backed bottleneck evidence. Raises duration alerts; `--check` posts a check run. | A token with `actions: read` |
| `review <cmd>` | Review program: `validate`, `run`, `intake`, `intake-artifact`, `intake-status`, `scheduled` | A token for API reads |
| `experiments <cmd>` | Hill climbing: `list`, `context`, `create`, `collect`, `evaluate`, `decide` | A token |
| `experiments plan` | Exactly optimize an explicit bounded CI job/mode/resource model; no publication | A model JSON file; no token |
| `recipes <cmd>` | Reusable fixes: `publish`, `apply`, `status`, `rollout` | A token |
| `knowledge <cmd>` | Authorized mitigation history: `applications`, `runs`, `inspect`, `refresh`, `evaluate` | `DATABASE_URL`, a token |
| `execution <cmd>` | Opt-in task capture on a runner, and authorized report `import` and `list` | `DATABASE_URL` for import and list |
| `maintenance <cmd>` | Operator-only `prune` and `purge`; previews unless confirmed | `DATABASE_URL` |
| `formal <cmd>` | Create/check primary-key partition, finite-selection and CI-model planning certificates; no execution attestation | Committed inputs; Git for source binding |

Exit codes: `0` success; `1` findings at or above `--fail-on`, or a failed operation; `2` a usage or configuration
error. `formal check` additionally returns `3` for model-valid evidence checked without its source repository, not
source-bound success. `experiments plan` returns `4` for proved model infeasibility and `5` for search-budget
exhaustion without a partial optimum. Certificate validity is separate from the model's `resultStatus`.
The Action exposes the code as its `exit-code` output.

## Scanning pull requests

Scanning pull requests means two different things here.

- **Your own pull requests.** The linter checks the pull request's changes and reports only the findings it
  introduces. Use the App, the Action, or the reusable workflow.
- **Pull requests that register another project.** The review program scans a different repository, the one the
  pull request registers. This is the [OSS-Fuzz-style flow](#reviewing-other-projects-oss-fuzz-style).

### Your own pull requests

**With the App.** Every `pull_request` (opened, synchronize, reopened, ready for review) gets a **CI/CD Optimizer**
check run. It annotates only the findings the pull request introduces compared with its base, and **Re-run**
repeats it. See [what the App does](docs/github-app.md#what-it-does).

**With the Action.** The [lint example](examples/workflows/cicd-optimizer-lint.yml) runs on pull requests and in the
merge queue:

```yaml
on:
  pull_request:
  merge_group:

permissions:
  contents: read

jobs:
  cicd-lint:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0              # --base needs the base commit
          filter: blob:none           # partial clone: history without old file contents
          persist-credentials: false
      - uses: MSFT-TKENDRICK/ci-cd-optimizer@<full commit SHA>   # see Versions and pinning
        with:
          command: lint
          args: >-
            --base ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
            --format github --fail-on error
```

`--format github` turns findings into pull request annotations. Make the job a required status check to block
merges on errors.

**With the reusable workflow.** [`lint-reusable.yml`](.github/workflows/lint-reusable.yml) asks only for
`contents: read` and uploads `cicd-optimizer.sarif` as an artifact. A separate job with `security-events: write` can
forward it to code scanning. See [linter.md › CI](docs/linter.md#ci) for both jobs and the inputs.

The same check also runs before the pull request exists, as a [git hook](docs/linter.md#git-hooks).

## Reviewing other projects, OSS-Fuzz style

The [project review program](docs/review-program/README.md) does for CI/CD configuration what
[OSS-Fuzz](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/) does for fuzzing. A
maintainer opens a pull request in this repository that registers a public repository. The program checks consent,
reviews the repository's default branch, and comments on the pull request. After merge, it re-reviews the project
every day and signs the results.

Reviews are static analysis through the GitHub API only. The program never checks out, builds, or runs a
registered project's code.

### How a submission works

1. **Consent.** The maintainer commits `.github/ci-cd-optimizer-review.yml` to the project's default branch. It
   names this registry, the project name, and the GitHub logins allowed to act for the project.
2. **Registration.** From a fork of this repository, they add `projects/<name>/project.yaml` with the repository
   URL, its numeric `repository_id` (`gh api repos/OWNER/REPO --jq .id`), and contacts. They can check it with
   `npm run cli -- review validate projects/<name>/project.yaml`.
3. **Intake on the pull request.** The pull request must change only that one file. Two workflows handle it:

   | Workflow | Trigger | Trust | Does |
   |---|---|---|---|
   | [Review intake](.github/workflows/review-intake.yml) | `pull_request` | Untrusted and advisory, because a pull request can rewrite it. Read-only token, no secrets, base commit checked out. | Validates the submission, checks consent, and reviews the project. Hands a tiny `{pr_number, head_sha}` record to the next workflow. |
   | [Review intake comment](.github/workflows/review-intake-comment.yml) | `workflow_run` | Trusted. Runs from the default branch and never checks out or runs pull request code. | Repeats intake through the API, comments the findings on the pull request, and sets the `review-intake/trusted` commit status. Fails closed when the record is missing or invalid. |

   Branch protection requires `review-intake/trusted`, not the advisory check.
4. **Acceptance.** The status passes only when every [acceptance criterion](docs/review-program/README.md#acceptance-criteria)
   holds. For example, the repository must be public, not a fork, not archived, and its `repository_id` must match.
   The consent file must name this registry and project, and the pull request author must be a listed contact. An
   author can have at most 3 other open submissions.
5. **Merge and daily reviews.** A code owner merges. Every day, the
   [daily workflow](.github/workflows/cicd-optimizer-daily.yml) calls
   [Review scheduled](.github/workflows/review-scheduled.yml), which re-reviews every registered project and
   re-verifies consent every time.

### What the project gets

| Result | Where | Signed |
|---|---|---|
| Findings table with suggested fixes, updated on each push | A comment on the submission pull request | No. It comes from a `pull_request` run that the submitter controls. |
| Daily summary | The `review` job summary of the [CI/CD Optimizer daily](https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/actions/workflows/cicd-optimizer-daily.yml) run | — |
| Public JSON report per project | The `review-reports` artifact, kept 90 days | Yes. Build provenance attestation through Sigstore. |
| Full detail, including withheld findings | `GITHUB_TOKEN=$(gh auth token) npm run cli -- review run projects/<name>/project.yaml` | — |

Anyone can check that a report is the program's own unmodified output:

```sh
gh attestation verify reports/<project>.json \
  --repo MSFT-TKENDRICK/ci-cd-optimizer \
  --signer-workflow MSFT-TKENDRICK/ci-cd-optimizer/.github/workflows/review-scheduled.yml@refs/heads/main \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

The signing job holds the OIDC token and never checks out or runs repository code; it only signs the files the
review job produced. The `review-attestation` artifact allows offline checks with `--bundle`. See
[verifying signed results](docs/review-program/README.md#verifying-signed-results) for the download steps.

Public reports and comments show **only counts** of security-sensitive findings, such as unpinned actions,
untrusted input in privileged workflows, or broad permissions. Maintainers get the details privately. Disclosure
follows the OSS-Fuzz model of 90 days plus a 14-day grace period. A project leaves by setting `paused: true`,
deleting its consent file, or removing its `project.yaml`. Reviews honor the project's own
`.github/ci-cd-optimizer.yml` and read at most 200 files of 200 KB each.

More detail: [how to submit](docs/review-program/README.md#how-to-submit),
[disclosure](docs/review-program/README.md#security-sensitive-findings-and-disclosure),
[design](docs/review-program/design.md), and [threat model](docs/review-program/threat-model.md). This repository
registers itself as the reference example in [projects/ci-cd-optimizer](projects/ci-cd-optimizer/project.yaml).

## What it finds

130 rules in 15 rulesets, configurable like ESLint: presets, per-rule severity and options, path ignores, and inline
suppressions.

| Ruleset | Examples |
|---|---|
| `workflow` | Concurrency cancellation, job timeouts, merge queue support, matrix coverage/budgets, duplicate triggers, setup version files |
| `checkout` | Sparse checkout, partial clone (`filter: blob:none`), correct base refs for affected detection |
| `affected` | Change detection, affected-only test selection instead of `nx run-many`, `turbo run`, `lerna run`, `pnpm -r`, workspace-wide npm/Yarn, or `bazel test //...`, path-filtered required checks |
| `caching` | setup-* dependency caches, build-tool caches, matrix platform compatibility, artifact compression, redundant installs |
| `hermeticity` | Frozen lockfiles, pinned actions, runners, container images, and base image digests |
| `containers` | Dependency layers, multi-stage builds, BuildKit cache scope/mode and mounts, context size, QEMU, verified script downloads |
| `packages` | Monolith decomposition signals, `exports` maps, `files` allowlists, version drift across a monorepo |
| `registries` | Publishing images to GHCR and packages to the GitHub npm registry for org-wide reuse |
| `triggers` | Draft pull request gating, noisy `pull_request` types, over-frequent schedules, `workflow_run` chains, serialized matrices |
| `redundancy` | Duplicate setup steps and commands, the same build repeated per job, toolchain version drift, shadowed `env` |
| `testing` | Playwright browser caching, incremental tool caches, watch mode in CI, masked failures, fixed sleeps |
| `security` | Expression injection, untrusted checkouts in privileged triggers, cache poisoning, excessive token permissions, persisted credentials |
| `nix` | 37 rules for CI configuration, evaluation inputs, flake locks, cache/trust boundaries, fetchers, derivations and image layers |
| `toolchains` | 10 rules for Gradle cache/parallel settings, Cargo locking/incremental builds and Rust selection, Bazel, pip, uv and Go |

Presets are `recommended` (default), `strict`, `agentic`, `github`, `insights`, and `all`. The full catalog with
rationale, examples, and references is in [docs/rules.md](docs/rules.md). Configuration is covered in
[docs/configuration.md](docs/configuration.md), and suppressions and custom local rules in
[docs/linter.md](docs/linter.md#suppressions).

The directory, Git-revision, and GitHub API loaders share an inventory of workflows/composite actions, Dockerfiles
and containerfiles, package manifests/locks, `*.nix`, `flake.lock`, devenv files, `.cargo/config[.toml]`, Gradle
configuration, requirements files, and supported toolchain version files. See [supported inputs](docs/linter.md#supported-inputs)
and the [Nix guide](docs/nix.md). Repository code is not evaluated or built by the built-in rules.

**Findings are not universal formal proofs of correctness, hermeticity, or performance.** Detectors use bounded
static models; an unmodeled construct or no finding does not establish safety. Severity, impact and confidence are
heuristic judgments. Tests and corpus cases check concrete behavior, while performance claims require measurements
on the relevant workload. All 64 rules in this expansion are advisory, without automatic edits. The 11 existing
fixable rules still require review and validation; “fixable” is not a proof of semantic equivalence.

## Acting on findings

These run from the App, `scan`, and `telemetry`:

- **Issues.** Findings at or above `issues.minSeverity`/`minImpact` open one issue per rule (or per finding).
  Issues are fingerprinted, updated in place, closed when resolved, and capped by `maxOpen`. With
  `assignCopilot: true` they are assigned to the Copilot coding agent with custom instructions.
- **Fix pull requests.** Available autofixes are grouped (by ruleset or by named groups) into branches under
  `cicd-optimizer/`, with Dependabot-style commands in the PR body.
- **Duration alerts.** Each workflow run is compared with up to `alerts.window` prior successful runs. Two checks run:
  - **Spike:** a single run with robust z ≥ 3.5, using median and MAD.
  - **Regression:** a sustained step change, where the last 5 runs are slower by a one-sided Mann-Whitney U test with
    p < 0.01.

  Both also need a material increase (20% and 30 s by default). Alerts open an issue with a duration chart and
  close themselves after recovery.

Details: [docs/issues-and-alerts.md](docs/issues-and-alerts.md).

## Hill climbing with GitHub Agentic Workflows

Rules and pipelines evolve through experiments on `experiments/<name>/<arm>` branches:

1. **[experiment-generator](.github/workflows/experiment-generator.md)** (weekly) reads telemetry and findings,
   proposes an experiment scored against the rubric in [.github/hill-climb.yml](.github/hill-climb.yml), and creates
   `experiments/<name>/trunk` with a manifest.
2. **[experiment-arm](.github/workflows/experiment-arm.md)** runs once per arm, in parallel. It implements the arm's
   approach and opens a pull request into the trunk.
3. **[experiment-grader](.github/workflows/experiment-grader.md)** (daily) measures each arm:
   - corpus precision, recall, and fix rate for `rules` experiments;
   - CI durations with a one-sided Mann-Whitney U test against the control for `pipeline` experiments.

   It then promotes the winner into the trunk and opens the trunk → `main` PR for human review.

Publication automatically uses the configured App; workflow dispatch uses a separate built-in Actions token.
An interrupted trunk publication can be recovered with `experiments resume --experiment NAME --expected-head SHA`.
See [docs/experiments.md](docs/experiments.md) for credential fallbacks, guarded recovery, and the threat model.

## Formal guarantees and their limits

Production decisions execute a Dafny-verified finite selector, not a second handwritten ranking algorithm.
It preserves hard eligibility gates and selects a deterministic maximum of the **declared eligible candidates**
under the configured quantized objective. Severity precedence also executes a verified last-assignment-wins fold.
Neither establishes a global policy optimum, authenticates measurements, nor proves that an experiment did
equivalent work or removed a real bottleneck.

For actual scheduling policies, [`experiments plan`](docs/ci-policy-planning.md) executes a separate verified
optimizer over a bounded CI environment: jobs, dependencies, selectable duration/cost/resource modes, runner
capacity and horizon. It proves feasibility and lexicographic makespan/cost optimality over **every admissible
policy in that declared model**, including complete search-space coverage. Insufficient search budgets return
no policy and no optimum/infeasibility claim. `experiments context --model` uses the real planner to inform
candidate proposals; it never replaces measured-evidence promotion gates. Workflow correspondence, equivalent
work and timing/resource profiles remain declared assumptions, not authenticated facts.

Optional cache-key certificates prove primary-key equality partitions **relative to declared component
dependencies**, not cache lookup behavior, safe workload dependencies, or speed. The checker recomputes from
immutable Git blobs and executes the generated model; a certificate digest is not a signature.

**Not every rule has a detector or performance proof.** Every built-in has an explicit entry in the
[machine-readable assurance catalogue](formal/rule-assurance.json); currently their detectors and recommendations
remain heuristic/conditional. `rules --format json`, `lint --explain`, and the [rule reference](docs/rules.md)
expose this distinction. CI rejects missing/stale entries and stale generated proofs.

See [formal-verification.md](docs/formal-verification.md) for precise theorems, assumptions, commands, and
source-bound versus model-only validation.

## Recipes: reusing a winning fix elsewhere

When a promoted `pipeline` experiment merges, [recipe-publish](.github/workflows/recipe-publish.yml) turns its
change set into `recipes/<name>.yml`. The recipe records the rules it fixes, the files it touches, a risk class, and
the measured improvement.

[recipe-rollout](.github/workflows/recipe-rollout.yml) applies it to the repositories in `.github/recipe-targets.yml`:
- canaries first, then waves that only advance while the Wilson lower bound of the CI pass rate stays above the
  threshold;
- an autofix PR where the linter can reproduce the change;
- otherwise an adaptation issue for the Copilot coding agent.

See [docs/recipes.md](docs/recipes.md).

## Evidence-backed project history

The hosted App uses PostgreSQL to link revision-specific project/technology declarations, immutable run attempts,
conservative duration cohorts, and versioned mitigation applications/evaluations. Opt-in `recipes apply|rollout
--record-knowledge` verifies a published recipe before recording target proposals. `knowledge applications|runs|inspect`
provides authorized history; `knowledge refresh|evaluate` records lifecycle state and explicit observational comparisons.
Merging a PR, closing an issue, or passing compatibility checks is not treated as proof of performance benefit.

`execution capture` can wrap a runner command and record timing, checkout context and reported tool/cache observations.
`execution import|list` checks exact run/attempt/job access while retaining **operator-supplied**, non-attested provenance.
Reports never execute code during import and do not silently become trusted duration samples or project attribution.

History is retained by default. Operator-only `maintenance prune|purge` previews its impact and requires a current
confirmation digest before any deletion; referenced evidence is preserved during pruning. No automatic deletion on
App removal is enabled. See [runtime report usage](docs/github-app.md#optional-task-execution-reports),
[retention/removal procedures](docs/github-app.md#knowledge-retention-and-removal), and
[model boundaries](docs/architecture.md#project-declaration-evidence-srcknowledge).

## Versions and pinning

The latest release is [v0.2.0](https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/releases/tag/v0.2.0), and the `v0`
tag points to it. It predates the standalone linter (`cicd-lint`, path and stdin input, suppressions, local rules,
the reusable workflow, and the pre-commit hook), the review program, signed reports, the setup wizard, and the
knowledge, execution, and maintenance commands. Until the next release, pin the Action, the reusable workflow, and
the pre-commit hook to a full commit SHA from `main`:

```sh
gh api repos/MSFT-TKENDRICK/ci-cd-optimizer/commits/main --jq .sha
```

The [examples](examples/workflows/) use `@v0` for brevity. Prefer a full commit SHA, which is immutable. Release and
retag steps are in [setup › Releases](docs/setup.md#7-releases).

## Project status

What is exercised continuously in this repository, and what is not yet:

| Area | Status |
|---|---|
| Linter, CLI, Action, reusable workflow | Tested in CI on every push. The Action and reusable workflow lint this repository. |
| Daily self-apply ([cicd-optimizer-daily.yml](.github/workflows/cicd-optimizer-daily.yml)) | Runs here every day: scans this repository (code scanning, finding issues, fix pull requests), re-reviews and signs every registered project, and audits this repository with every rule and for stale suppressions. The scan also runs after pushes to `main` that change CI files. |
| `telemetry` workflow | Runs after CI, Container, and CI/CD Optimizer daily runs in this repository; queued updates preserve snapshot history. |
| Container image and App service | Built in CI and smoke-tested against a synthetic GitHub API, in direct and Postgres queue modes. Pushed to `ghcr.io/msft-tkendrick/ci-cd-optimizer` on every push to `main`. |
| Review program intake and signed daily reports | Running here, with this repository registered. `gh attestation verify` passes on published reports and rejects modified copies. |
| pre-commit hook | The hook script has unit tests, and the hook was verified with pre-commit 4.6.2 in a consumer repository. pre-commit itself does not run in CI. |
| Experiment generator and grader | Weekly proposal and daily grading, with App-backed publication, configured capacity checks, clean no-work skips, and guarded partial-publication recovery. Promotion selects among measured qualifying arms; it is not a guarantee of workload equivalence or future speed. |
| Recipe publish and rollout | Not yet run here: no promoted pipeline experiment exists. |
| Review intake from a fork | Designed for it (fail-closed trusted status), not yet exercised with an outside submission. |
| MCP App setup panel | Works in the stand-in host (`npm run preview:mcp`); not yet validated in Copilot Desktop. |
| npm package | Not published; [install from a clone](#install-the-cli). |

## Tokens and permissions

| Credential | Used by | Needed for |
|---|---|---|
| `GITHUB_TOKEN` | All workflows | Lint, SARIF upload, issues, telemetry checks, review intake and daily reviews |
| `id-token: write`, `attestations: write` | The `sign` job in review-scheduled only (the daily workflow's `review` job grants them) | Signing the daily review reports |
| `secrets.CICD_OPTIMIZER_TOKEN` (optional App token or fine-grained PAT) | Scan, gh-aw safe outputs, recipe publication | Fallback when no App is configured; workflow-changing fixes require `workflows: write` |
| `vars.CICD_OPTIMIZER_APP_ID` + `secrets.CICD_OPTIMIZER_APP_PRIVATE_KEY` | Scan, experiments, recipe publication/rollout | Short-lived installation tokens for branch and PR writes, including target-repository recipe PRs |
| `CICD_OPTIMIZER_DISPATCH_TOKEN` (job-local, not a secret setting) | Experiment generator and grader | Built-in Actions-write job token for workflow dispatch; no increase to the App's Actions-read permission |
| `secrets.COPILOT_ASSIGN_TOKEN` (user token) | Scan, telemetry, rollout | Assigning issues to the Copilot coding agent |
| `secrets.CICD_OPTIMIZER_DATABASE_URL` (optional) | Recipe rollout | Protected access to the App's evidence database; never expose it to untrusted experiment arms |
| `permissions: copilot-requests: write` | gh-aw workflows | Copilot inference without a PAT (requires an org Copilot subscription; otherwise set `COPILOT_GITHUB_TOKEN`) |

> **Credential boundary.** App private keys and publication tokens are used only in isolated publishing jobs, never
> in inference or arm evaluation. Publication prefers the App, then the optional publisher token, then `GITHUB_TOKEN`;
> the last fallback cannot edit workflows or trigger CI on its own PRs. Workflow dispatch uses the separate built-in
> Actions-write job token. Keep repository-default workflow permissions read-only. The review program uses no stored secrets.

The App's own permissions are listed in [github-app.md](docs/github-app.md#register-the-app). The production
checklist (repository security, GHCR, App credentials, tokens, and releases) is [docs/setup.md](docs/setup.md).

## Development

Requires Node.js 22 (see `.nvmrc`).

```sh
npm ci
npm run typecheck && npm run lint && npm test
npm run bundle           # rebuild dist-action/index.js (CI fails when it is stale)
npm run build:ui         # rebuild dist-setup/, the setup panel (CI fails when it is stale)
npm run preview:mcp      # preview the setup panel in a stand-in MCP Apps host against a fake GitHub (docs/setup.md)
npm run docs:rules       # regenerate docs/rules.md
npm run assurance:check # every built-in detector/recommendation has an explicit current assurance entry
npm run formal:setup    # install the SHA-256-pinned Dafny/Z3 distribution
npm run formal:check    # verify theorems and check deterministic source/runtime regeneration
npm run cli -- experiments evaluate --engine dist/lint/api.js --corpus corpus   # benchmark
```

Postgres integration tests run when `DATABASE_URL` is set. Use only a disposable test database: they create/drop
isolated schemas, and readiness permission tests create a temporary NOLOGIN role (requiring `CREATEROLE`) and remove
its grants and role afterward. CI provides its own disposable Postgres service; never use production credentials.

`npm test` still runs both Vitest projects and the Node setup tests locally. CI runs the `service` project
and Node tests in the test job, and the `setup-ui` project in the lint job using its existing dependency
installation. UI tests also run on draft PRs and after a lint failure, provided dependency setup succeeded.

Rules live in `src/lint/rules/<ruleset>/<rule>.ts` and are tested with the ESLint-style `RuleTester` in
`test/lint/rule-tester.ts`. Every rule needs valid and invalid cases plus autofix output checks. New rules should
also add a corpus case ([corpus/README.md](corpus/README.md)) so precision and recall stay measured.
After reviewing changed rule claims, run `npm run assurance:generate` and `npm run docs:rules`.
After changing production TypeScript, dependencies, models, or proof tooling, run `npm run formal:generate`
to verify and update the executable kernel/build stamp; see [the proof development contract](docs/formal-verification.md#verification-and-regeneration).

Architecture: [docs/architecture.md](docs/architecture.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
