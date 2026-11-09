# Project review program: design

This document explains how the [project review program](README.md) is put together and why. The security
reasoning is in the [threat model](threat-model.md), and the survey of comparable programs is in
[research.md](research.md).

## Goals and non-goals

- **Goals:** a self-service, PR-based registry, like OSS-Fuzz `projects/<name>/project.yaml`; explicit consent from
  the target repository; useful public feedback on the submission PR; daily re-review; first-class opt-out; no
  secrets, and no write access to target repositories.
- **Non-goals:** executing or building target code (unlike OSS-Fuzz or Homebrew, which build submissions); opening
  issues or pull requests against target repositories; scoring or ranking projects; a hosted service. Everything
  runs in this repository's GitHub Actions with `GITHUB_TOKEN`.

## Components

| Piece | Responsibility |
| --- | --- |
| `projects/<name>/project.yaml` + `projects/schema.json` | Registry entry and its JSON Schema (`additionalProperties: false`). The schema is for editors and reviewers; the code validator in `src/review/project.ts` is authoritative and stricter. |
| `src/review/project.ts` | Hardened YAML parsing (`parseStrictYaml`) and project validation, including the exact `https://github.com/<owner>/<repo>` URL grammar. |
| `src/review/consent.ts` | Loads repository metadata by immutable id, pins the default-branch SHA, and reads and checks `.github/ci-cd-optimizer-review.yml` at that SHA. |
| `src/review/review.ts` | Runs the existing lint engine (`loadRepositorySnapshot` + `lint`) on the pinned SHA with the target's own config, clamped limits (200 files, 200 KB per file, concurrency 4), and the project's `preset`. |
| `src/review/report.ts` | Report model (`schemaVersion: 1`), public-mode redaction, Markdown and JSON rendering, and the marker-based comment upsert. |
| `src/review/escape.ts` | `escapeInline`, used on every untrusted string before it reaches Markdown, plus the 60 KB comment cap. |
| `src/review/intake.ts` | Submission PR classification, the intake flow, the per-author cap, the intake record parser, and the trusted status decision. |
| `src/cli/review.ts` | `review validate`, `run`, `intake`, `intake-artifact`, `intake-status`, and `scheduled` subcommands. `scheduled --json-dir` writes one public JSON report per project for signing. |
| `.github/workflows/review-intake.yml` | Unprivileged, advisory `pull_request` job: runs intake from the **base** commit and writes the job summary plus a tiny record. |
| `.github/workflows/review-intake-comment.yml` | Privileged `workflow_run` job: validates the record, repeats intake from the default branch, upserts the PR comment, and publishes the required `review-intake/trusted` commit status. |
| `.github/workflows/review-scheduled.yml` | Daily read-only re-review of every registered project, called by `cicd-optimizer-daily.yml`. The `review` job writes the job summary and uploads `review-reports` (one JSON file per project). A separate `sign` job attests those files with `actions/attest` and uploads the Sigstore bundle as `review-attestation`. |

## Data flow

```
submitter PR (fork) ──pull_request──▶ Review intake (read-only token, base-commit code)
                                         │  API: PR, PR files, project.yaml blob at head SHA (data only)
                                         │  API: target metadata by id, consent file, CI/CD files at default SHA
                                         ├─▶ job summary (escaped, redacted)
                                         └─▶ artifact review-intake: {"pr_number":N,"head_sha":"<40 hex>"}
                                                       │
                     workflow_run (completed) ◀────────┘
                               │
                 Review intake comment (pull-requests: write, statuses: write, default-branch code, no PR code)
                   1. artifact listing: exactly one, ≤ 4 KB      2. review intake-artifact: strict JSON,
                   3. head_sha == workflow_run.head_sha             canonical, SHA match
                   4. review intake-status --head-sha SHA --record present|missing|invalid [--pr N]
                        --comment --status
                      - evaluates every open PR whose head is SHA (plus N), re-fetching each one
                      - present: repeats intake for N; missing/invalid: any PR touching projects/ fails closed
                      - sets commit status review-intake/trusted (the required check) and upserts comments
```

The trusted job does not trust anything in the intake run's output except the PR number. It accepts that number
only after the record proves it describes the same commit that the `workflow_run` event reports, and it then
recomputes the whole review itself with trusted code. The record only selects a path: a missing, oversized, or
malformed record makes every submission at that commit fail. A forged record can therefore at most trigger a
fresh, honest review of some open pull request whose head is that commit, or make it fail.

The daily run has a second, signed output:

```
schedule / workflow_dispatch on main (cicd-optimizer-daily.yml calls review-scheduled.yml)
  review job (contents: read, default-branch code)
    review scheduled --json-dir reports ──▶ job summary
                                       └──▶ artifact review-reports: reports/<project>.json (public, redacted)
  sign job (id-token: write, attestations: write; no checkout, no npm, no repo code)
    download review-reports ──▶ actions/attest (SLSA provenance, Sigstore) ──▶ attestation API + Rekor
                                                                      └──▶ artifact review-attestation (bundle)
```

Report files are named after the project directory. A directory whose name is not a valid project name is written
as `_invalid-<n>.json` instead, numbered in sorted order, so an untrusted name never becomes a path and two names
cannot collide. Reports contain no timestamps, so re-running a review on unchanged inputs produces byte-identical
files and digests.

## Intake rules

1. The pull request's files are listed with the API. If none touch `projects/` (other than `schema.json` and
   `README.md`), intake reports "nothing to review" and passes, so the status can be required on every PR. The
   comparison is case-insensitive, so `Projects/` cannot sidestep it.
2. Otherwise the PR must change exactly one `projects/<name>/project.yaml`, with status `added`, `modified`, or
   `removed`. Renames, extra files, traversal or odd paths, and lists truncated by the API are rejected.
3. The head SHA is checked against `--head-sha` before and after listing files, closing the window in which a push
   could change the file list or the blob.
4. The author must be a `User` account. Bots and apps cannot submit.
5. `removed` is an opt-out. It is accepted when the author is a contact of the existing entry. If the existing
   entry on the base branch cannot be read or validated, the change fails closed and needs a maintainer.
6. `modified` must keep `repository_id` and must come from a current contact.
7. Authors may have at most 3 other open submission PRs.
8. `project.yaml` is read with the contents API at the head SHA (falling back to the head repository for forks),
   as data, capped at 8 KB.
9. Consent is verified and the project is reviewed in public mode.

Intake fails (exit 1) for invalid submissions and consent failures, and the trusted job turns that into a failing
`review-intake/trusted` status, so branch protection can block merging them. Lint findings themselves never fail
intake.

## Consent and identity

- **Repository id is the anchor.** `GET /repositories/{id}` is the first call. Renames, transfers, and
  delete-and-recreate attacks surface as an id or `full_name` mismatch; a mismatch tells the submitter to update
  `main_repo`.
- **The consent file lives in the target repository,** at the SHA being reviewed, and lists who may act for the
  project. This is the conda-forge `recipe-maintainers` and DefinitelyTyped `owners` model, but the list lives on
  the target side, so a submitter cannot volunteer someone else's repository or someone else's handle.
- **Every review re-verifies consent.** Deleting the file is an immediate opt-out without touching this
  repository.
- **No collaborator-permission check.** `GET /repos/{owner}/{repo}/collaborators/{user}/permission` requires push
  access to the target, which the program will not request. Control of the default branch already proves
  authority.

## Review and redaction

The review lints the files at one pinned SHA and honors the target's `.github/ci-cd-optimizer.yml`, read with a
64 KB cap. A `preset` in `project.yaml` overrides `extends`. Limits are clamped so that a hostile configuration
cannot raise them.

Public reports redact a finding when its rule is in `SENSITIVE_RULES`, or when its message or suggestion matches
`/pull_request_target|permissions|secret|token|injection|untrusted/i`. Only the count and the number of distinct
rules are published. The rule set is `hermeticity/pin-actions`, `hermeticity/pin-container-images`,
`hermeticity/docker-base-digest`, and `affected/trusted-change-detection`. Rules that talk about permissions,
secrets, tokens, or `pull_request_target` are caught by the message filter. When consent fails, no findings are
computed at all. Maintainers can see everything with `review run`, which defaults to private mode.

## Comments

Each comment begins with `<!-- ci-cd-optimizer-review:<name> -->`. Upserts only edit a comment whose first line is
exactly that marker **and** whose author is `github-actions[bot]` of type `Bot`, so a user cannot plant a marker to
redirect edits. Every interpolated value goes through `escapeInline`, which does the following:

- strips C0/C1 controls, bidi controls, zero-width characters, the BOM, and tag characters;
- collapses newlines;
- encodes `& < >`;
- backslash-escapes Markdown punctuation;
- inserts a zero-width space after `@`, `#`, `:` before `:` or `/`, and `www`/`gh` before `.` or `-`;
- caps each value at 300 characters.

The whole comment is capped at 60 KB.

## Comparison with other programs

| | OSS-Fuzz | conda-forge | DefinitelyTyped | Scorecard | **This program** |
| --- | --- | --- | --- | --- | --- |
| Submission | PR with `projects/<n>/project.yaml` | PR with `meta.yaml` | PR with `types/<pkg>` | none (crawl or Action) | PR with `projects/<n>/project.yaml` |
| Consent | `primary_contact` + VCS-log check | `recipe-maintainers` | `owners` | none | consent file **in the target repo** + contacts |
| Executes submission | yes (Docker build) | yes (build) | type-check | no | **no** (API-only lint) |
| Results | private tracker, then public | CI logs | CI status | public score | PR comment (redacted), signed daily JSON, and local full report |
| Disclosure | 90 days + 14-day grace | n/a | n/a | n/a | 90 days for sensitive findings |
| Re-review | continuous | per update PR | per PR | every CI run / weekly crawl | daily |
| Opt-out | PR deleting the project (implied, not documented) | not documented | not documented | stop running the Action | delete consent file, `paused`, or removal PR |

See [research.md](research.md) for sources and the other programs surveyed (ClusterFuzzLite, Best Practices Badge,
Allstar, SLSA, Alpha-Omega, verify-rust-std, SV-COMP, VerifyThis, CNCF Landscape, Homebrew, Renovate, Flathub).

## Deliberate choices and deviations

- **A commit status, not a job, is the required check.** A `pull_request` run uses the workflow file from the pull
  request, so its job result can be faked. The `workflow_run` job always runs the default-branch workflow, so its
  `review-intake/trusted` status is what branch protection requires.
- **No `paths:` filter on `review-intake.yml`.** The trusted status is required, and it is only published after an
  intake run, so intake must run on every PR. This repository's own `affected/path-filter-required-checks` rule
  flags path-filtered required checks. Intake exits quickly with "nothing to review" instead.
- **`merge_group` trigger** with the intake job skipped; the trusted job marks the merge group commit as passing,
  because every pull request in it already carries a passing status (`workflow/merge-group`).
- **Bootstrap guard.** When the base commit does not contain `src/review/intake.ts` yet (the PR that introduces
  the program), intake emits a notice and skips.
- **Per-author cap rather than global rate limiting.** GitHub already rate-limits `GITHUB_TOKEN`, and a daily
  sequential run keeps load predictable.
- **No issue filing on target repositories.** Feedback stays on the submission PR, in the daily summary, and in
  private channels, which keeps the token read-only toward targets.
- **Signing runs in its own job.** Only the `sign` job can mint an OIDC token, and it runs no code from this
  repository: it downloads the reports and calls a pinned `actions/attest`. A bug in the review code therefore
  cannot sign arbitrary content, and the `review` job keeps `contents: read` only. OSS-Fuzz and SLSA use the same
  split between the build and the provenance generator.
- **Only scheduled results are signed.** Submission PR results come from `pull_request` runs whose workflow file the
  submitter controls, so a signature from them would prove nothing. The trusted `workflow_run` job could sign its
  own result in a follow-up.
- **Only public reports are signed and published.** Private detail stays with `review run`. The JSON artifact is the
  same redacted content as the job summary.
- **Attestations, not detached keys.** Sigstore keyless signing ties each signature to this workflow's identity, so
  there is no long-lived key to store, rotate, or leak, and anyone can verify with `gh attestation verify`.
