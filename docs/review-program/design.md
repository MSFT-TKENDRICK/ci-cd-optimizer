# Project review program: design

This document explains how the [project review program](README.md) is put together and why. The security
reasoning is in the [threat model](threat-model.md), and the survey of comparable programs is in
[research.md](research.md).

## Goals and non-goals

- **Goals:** a self-service, PR-based registry, like OSS-Fuzz `projects/<name>/project.yaml`; explicit consent from
  the target repository; useful public feedback on the submission PR; weekly re-review; first-class opt-out; no
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
| `src/review/intake.ts` | Submission PR classification, the intake flow, the per-author cap, and the intake record parser. |
| `src/cli/review.ts` | `review validate`, `run`, `intake`, `intake-artifact`, and `scheduled` subcommands. |
| `.github/workflows/review-intake.yml` | Unprivileged `pull_request` job: runs intake from the **base** commit and writes the job summary plus a tiny record. |
| `.github/workflows/review-intake-comment.yml` | Privileged `workflow_run` job: validates the record, re-runs intake from the default branch, and upserts the PR comment. |
| `.github/workflows/review-scheduled.yml` | Weekly read-only re-review of every registered project; output goes to the job summary. |

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
                 Review intake comment (pull-requests: write, default-branch code, no PR code)
                   1. artifact listing: exactly one, ≤ 4 KB      2. review intake-artifact: strict JSON,
                   3. head_sha == workflow_run.head_sha             canonical, SHA match
                   4. review intake --pr N --head-sha SHA --comment  (re-fetches the PR; stale → no comment)
```

The comment job does not trust anything in the intake run's output except the PR number. It accepts that number
only after the record proves it describes the same commit that the `workflow_run` event reports, and it then
recomputes the whole review itself with trusted code. A forged record can therefore at most trigger a fresh,
honest review of some open pull request whose head is that commit.

## Intake rules

1. The pull request's files are listed with the API. If none touch `projects/` (other than `schema.json` and
   `README.md`), intake reports "nothing to review" and passes, so the check can be required on every PR. The
   comparison is case-insensitive, so `Projects/` cannot sidestep it.
2. Otherwise the PR must change exactly one `projects/<name>/project.yaml`, with status `added`, `modified`, or
   `removed`. Renames, extra files, traversal or odd paths, and lists truncated by the API are rejected.
3. The head SHA is checked against `--head-sha` before and after listing files, closing the window in which a push
   could change the file list or the blob.
4. The author must be a `User` account. Bots and apps cannot submit.
5. `removed` is an opt-out. It is accepted when the author is a contact of the existing entry.
6. `modified` must keep `repository_id` and must come from a current contact.
7. Authors may have at most 3 other open submission PRs.
8. `project.yaml` is read with the contents API at the head SHA (falling back to the head repository for forks),
   as data, capped at 8 KB.
9. Consent is verified and the project is reviewed in public mode.

The intake check fails (exit 1) for invalid submissions and consent failures, so branch protection can block
merging them. Lint findings themselves never fail intake.

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
| Results | private tracker, then public | CI logs | CI status | public score | PR comment (redacted) + local full report |
| Disclosure | 90 days + 14-day grace | n/a | n/a | n/a | 90 days for sensitive findings |
| Re-review | continuous | per update PR | per PR | every CI run / weekly crawl | weekly |
| Opt-out | PR deleting the project (implied, not documented) | not documented | not documented | stop running the Action | delete consent file, `paused`, or removal PR |

See [research.md](research.md) for sources and the other programs surveyed (ClusterFuzzLite, Best Practices Badge,
Allstar, SLSA, Alpha-Omega, verify-rust-std, SV-COMP, VerifyThis, CNCF Landscape, Homebrew, Renovate, Flathub).

## Deliberate choices and deviations

- **No `paths:` filter on `review-intake.yml`.** The check is meant to be required, and a path-filtered required
  check never reports on unrelated PRs and blocks them. This repository's own `affected/path-filter-required-checks`
  rule flags that pattern. Intake exits quickly with "nothing to review" instead.
- **`merge_group` trigger** with the job skipped, so the required check reports in merge queues
  (`workflow/merge-group`).
- **Bootstrap guard.** When the base commit does not contain `src/review/intake.ts` yet (the PR that introduces
  the program), intake emits a notice and skips.
- **Per-author cap rather than global rate limiting.** GitHub already rate-limits `GITHUB_TOKEN`, and a weekly
  sequential run keeps load predictable.
- **No issue filing on target repositories.** Feedback stays on the submission PR, in the weekly summary, and in
  private channels, which keeps the token read-only toward targets.
