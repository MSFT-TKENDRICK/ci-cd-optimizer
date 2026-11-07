# Project review program: threat model

Scope: the registry in `projects/`, the `review` CLI (`src/review/`, `src/cli/review.ts`), and the three review
workflows. Assets: this repository's `GITHUB_TOKEN` (especially the `pull-requests: write` token in the comment
workflow), the integrity of the registry, the attention of target maintainers (notifications), and undisclosed
weaknesses in target repositories.

## Trust boundaries

| Zone | Trusted? | Notes |
| --- | --- | --- |
| Default-branch code of this repository | Yes | Protected by branch protection and CODEOWNERS. |
| Base commit of a pull request | Yes | It is a commit already on the base branch. `review-intake.yml` checks it out instead of the PR head. |
| Pull request head: files, YAML, workflow edits | **No** | It is read only as data, through the API, at a pinned SHA. |
| Artifacts, logs, and outputs of `pull_request` runs | **No** | A PR can edit the workflow that produced them. |
| Target repository content: consent file, CI/CD files, `.github/ci-cd-optimizer.yml` | **No** | It is parsed statically and escaped; it is never executed. |
| GitHub API metadata (ids, `full_name`, flags) | Mostly | It is authoritative for identity, but the strings in it are still escaped. |

## Threats

Each threat below is followed by its mitigation and the residual risk.

**S1. Spoofing: project hijack (someone registers a repository they do not control).**
- *Mitigation:*
  - The target repository must contain `.github/ci-cd-optimizer-review.yml` on its default branch naming this
    registry and project, and the PR author must be listed in `contacts`.
  - The file is read at the pinned default-branch SHA.
  - Changes to an existing entry require a current contact.
  - CODEOWNERS review is required for `projects/`.
- *Residual risk:* anyone with push access to the target can consent, which is intended. A compromised maintainer
  account can register the repository; the impact is limited to receiving public, redacted lint results.

**S2. Spoofing: rename or transfer hijack (an old `owner/repo` name is reused by someone else).**
- *Mitigation:*
  - `repository_id` is the immutable anchor and cannot change in a modify PR.
  - Every review fetches `GET /repositories/{id}` and requires `id` to match and `full_name` to equal `main_repo`.
  - The consent file is re-read from the repository resolved by id.
- *Residual risk:* after a transfer, reviews stop until `main_repo` is updated. A delete-and-recreate attack
  produces a new id, which fails.

**S3. Spoofing: mention spam (using the registry to ping strangers).**
- *Mitigation:*
  - `primary_contact` and `auto_ccs` must appear in the target's consent `contacts`.
  - `auto_ccs` is capped at 10.
  - Reports never `@`-mention anyone: every untrusted `@`, `#`, or `GH-` gets a zero-width space after it.
  - At most 3 other open submissions per author.
- *Residual risk:* none known. Contacts are not pinged by reports; they are only listed in YAML.

**T1. Tampering: pwn request, or a faked intake verdict, from a fork PR.**
- *Mitigation:*
  - Intake runs on `pull_request` (never `pull_request_target`) with `contents: read` and `pull-requests: read`,
    no secrets, `persist-credentials: false`, and checks out the **base** SHA, so the CLI that runs is trusted code.
  - A `pull_request` run uses the workflow file from the PR itself, so a PR can make the **Review intake** job pass
    without checking anything. That job is therefore advisory and is never the required check.
  - The required check is the commit status `review-intake/trusted`. Only the `workflow_run` job publishes it
    (`statuses: write`), from default-branch code that never downloads or executes PR code.
  - The trusted job evaluates every open PR whose head is the reported commit. It succeeds only if all of them pass,
    and at least one must exist.
  - If the intake run left no usable record, any PR at that commit that touches `projects/` gets a failing status
    and an explanatory comment; it never passes silently.
  - Unexpected errors set the status to `error`. A tampered or renamed intake workflow therefore produces a failing
    status or no status at all, and both block merging.
  - No `${{ }}` expressions appear in `run:` scripts; values are passed through `env:`.
- *Residual risk:*
  - Anyone with write access to this repository can set commit statuses, so branch protection must pin the
    expected source of `review-intake/trusted` to GitHub Actions. Write access already allows merging, so this
    adds no new capability.
  - Never enable "Send write tokens to workflows from pull requests" for forks.
  - Another PR at the same head commit can force a failing status. A maintainer closes it and re-runs intake.
  - A PR opened at a commit that already has a success status from another PR keeps that status until its own
    trusted run finishes. Code Owner review of `projects/` covers that window.
  - The status only appears once `review-intake-comment.yml` is on the default branch, because `workflow_run`
    always uses the default-branch workflow.

**T2. Tampering: forged artifact or workflow_run name spoofing.**
A PR adds a workflow named "Review intake" or edits the real one so that it uploads a crafted `review-intake`
artifact, aiming to make the privileged job pass, comment on, or act on a different PR.
- *Mitigation:*
  - The trusted job requires exactly one artifact of at most 4 KB, and the record inside it must be a regular file
    (not a symlink) of at most 1 KB. Anything else is treated as an invalid record and fails closed.
  - `review intake-artifact` requires canonical JSON with exactly `pr_number` (a positive integer) and `head_sha`
    (40 lowercase hex characters), and `head_sha` must equal `github.event.workflow_run.head_sha`.
  - `review intake-status` then re-fetches every PR it evaluates and requires its head to be that SHA.
  - The whole review is recomputed with default-branch code. The record only chooses between repeating intake for
    the PR it names and failing closed. A PR named by the record but not at that commit fails the status.
- *Residual risk:* an attacker can trigger a fresh, honest review of a PR whose head is the same commit, or force a
  failing status on that commit. Neither can make a submission pass.

**T3. Tampering: TOCTOU (the PR changes between checks).**
- *Mitigation:*
  - The head SHA is compared with `--head-sha` before listing files and again after.
  - `project.yaml` is fetched at that exact SHA.
  - A stale run reports "moved to …" and posts no comment; the newer push gets its own run.
  - The consent file and CI/CD files are read at one resolved default-branch SHA.
- *Residual risk:* the target's default branch may move after its SHA is pinned. The report names the reviewed SHA.

**T4. Tampering: comment injection (Markdown, HTML, links, or workflow commands from target files or YAML).**
- *Mitigation:* every untrusted string goes through `escapeInline`, which:
  - strips C0/C1, bidi (Trojan Source), zero-width, BOM, and tag characters;
  - collapses newlines;
  - entity-encodes `& < >`;
  - backslash-escapes Markdown punctuation;
  - breaks `@`, `#`, `://`, `::`, and `www.`;
  - caps each value at 300 characters.

  The comment as a whole is capped at 60 KB, and job summaries are capped too. `::` is broken so that stdout cannot
  carry workflow commands such as `::set-output`, `::add-mask`, or `::stop-commands`.
- *Residual risk:* rule messages written by this repository are trusted. A new formatter that bypasses
  `escapeInline` would reintroduce the risk; tests cover the shipped renderer.

**T5. Tampering: comment upsert hijack (a planted comment with the marker gets edited).**
- *Mitigation:* the upsert matches only comments whose first line is exactly the marker **and** whose author is
  `github-actions[bot]` of type `Bot`.
- *Residual risk:* none known.

**T6. Tampering: cache poisoning.**
- *Mitigation:*
  - The review workflows only restore the dependency cache of the setup action.
  - GitHub scopes caches by ref, so caches written by PR runs are invisible to default-branch runs (the comment and
    scheduled workflows).
  - The base checkout means a PR cannot change the cache key logic for intake.
  - `npm ci` verifies lockfile integrity hashes.
- *Residual risk:* inherited from GitHub's cache isolation model.

**R1. Repudiation: who registered or changed a project.**
- *Mitigation:*
  - Everything is a PR, with a CODEOWNERS approval and git history.
  - Consent lives in the target's own git history.
  - Reports name the reviewed SHA.
- *Residual risk:* none significant.

**I1. Information disclosure: publishing exploitable CI/CD weaknesses in public comments.**
- *Mitigation:*
  - Public mode reduces sensitive findings to counts: the rules `hermeticity/pin-actions`,
    `hermeticity/pin-container-images`, `hermeticity/docker-base-digest`, and `affected/trusted-change-detection`,
    plus any finding whose message mentions `pull_request_target`, permissions, secrets, tokens, injection, or
    untrusted input.
  - When consent fails, no findings are computed at all.
  - Full detail is only available locally (`review run`) or privately, under a 90-day disclosure policy.
- *Residual risk:*
  - A weakness phrased without those keywords could appear publicly. All findings come from the target's public
    files, which anyone could lint.
  - The redacted count reveals that something sensitive exists.

**I2. Information disclosure: token leakage.**
- *Mitigation:* `persist-credentials: false`, no secrets in intake, and the token is passed only through `env:` to
  the CLI and `gh`. No step echoes it.
- *Residual risk:* inherited from the runner.

**D1. Denial of service: alias bomb or YAML bomb.**
- *Mitigation:*
  - An 8 KB cap (project) or 4 KB cap (consent) is checked before parsing.
  - Exactly one document; anchors, aliases, merge keys, tags, directives, duplicate keys, warnings, and errors are
    all rejected.
  - `toJS({ maxAliasCount: 0 })` is applied as a second guard.
- *Residual risk:* none known.

**D2. Denial of service: huge or hostile target repositories.**
- *Mitigation:*
  - Limits are clamped to 200 files and 200 KB per file, with API concurrency of 4.
  - The target's own config is capped at 64 KB, and it cannot raise those limits.
  - Truncated trees are reported as partial.
  - Every job has a timeout.
  - Symbolic links (tree mode `120000`) and submodules are skipped when the tree is listed, so a link is never
    followed or read as file content. Files are read through the blob API.
- *Residual risk:* a pathological regex-heavy file within those limits could slow a single job until its timeout.

**D3. Denial of service: submission spam or API rate limits.**
- *Mitigation:*
  - Each author may have at most 3 other open submission PRs.
  - First-time contributor workflow runs need maintainer approval (a repository setting).
  - Concurrency groups cancel superseded runs.
  - The weekly scheduled review runs sequentially.
- *Residual risk:* many accounts could still open PRs, but the runs stay unprivileged.

**E1. Elevation of privilege: malicious target content.**
- *Mitigation:*
  - Target files are only read through the API and linted statically.
  - Nothing from the target is executed, installed, or checked out, and nothing is written back.
- *Residual risk:* parser bugs in the lint engine. They run in an ephemeral runner with a read-only token.

**E2. Elevation of privilege: submitter-controlled `preset` or config.**
- *Mitigation:*
  - `preset` is an enum.
  - The target config is parsed by the existing loader, and its limits are clamped.
  - Plugin, extension, and exec settings do not exist in the config schema.
- *Residual risk:* none known.

## Why not the collaborator-permission API?

`GET /repos/{owner}/{repo}/collaborators/{username}/permission` would directly confirm that the submitter can push
to the target. However, it requires push access to the target repository, and the program's `GITHUB_TOKEN` is
scoped to this repository only. Asking maintainers to install an app with access to their repository would expand
the program's privileges for every participant. The consent file proves the same thing (control of the default
branch) without granting anything.

## Repository settings the program relies on

- Branch protection on `main` that requires the commit status **`review-intake/trusted`** (expected source:
  GitHub Actions) and CI, and requires review from Code Owners. Do not require the **Review intake** job itself:
  a pull request can rewrite it.
- CODEOWNERS covers `projects/`, the workflows, the setup action, `src/`, and the package and Node version files,
  so changes to the code that runs in the trusted job need owner review.
- Actions → "Require approval for all outside collaborators" for fork pull request workflows.
- Private vulnerability reporting enabled.
- Workflow permissions defaulting to read-only. Each workflow also declares its own minimal `permissions`.
