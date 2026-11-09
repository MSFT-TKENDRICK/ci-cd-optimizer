# Project review program

The CI/CD optimizer project review program reviews the CI/CD configuration of public open source repositories,
in the spirit of [OSS-Fuzz](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/). It covers
GitHub Actions workflows, Dockerfiles, lockfiles, and related build and release files. A maintainer opens a pull
request here that registers the repository. The program checks that the repository consents, lints its default
branch through the GitHub API, and posts the results on the pull request. Registered projects are then re-reviewed
every day.

The review is static analysis through the GitHub API only. The program never checks out, builds, or runs your code.

- [How to submit](#how-to-submit)
- [Acceptance criteria](#acceptance-criteria)
- [The consent file](#the-consent-file)
- [What you get](#what-you-get)
- [Verifying signed results](#verifying-signed-results)
- [Security-sensitive findings and disclosure](#security-sensitive-findings-and-disclosure)
- [Changing, pausing, or leaving the program](#changing-pausing-or-leaving-the-program)
- Background: [design](design.md), [threat model](threat-model.md), [research on comparable programs](research.md)

## How to submit

1. **Commit a consent file** to your repository's default branch at `.github/ci-cd-optimizer-review.yml`:

   ```yaml
   registry: MSFT-TKENDRICK/ci-cd-optimizer
   project: my-project            # the <name> you will register below
   contacts:                      # GitHub logins allowed to act for the project
     - your-login
     - co-maintainer-login
   ```

2. **Look up your repository's numeric id.** The id never changes, even when a repository is renamed or transferred:

   ```sh
   gh api repos/OWNER/REPO --jq .id
   ```

3. **Fork this repository and add `projects/<name>/project.yaml`.** Use your fork, not a branch here. For example:

   ```yaml
   # yaml-language-server: $schema=../schema.json
   name: my-project                          # must equal the directory name
   main_repo: https://github.com/OWNER/REPO  # exact form; no trailing slash or .git
   repository_id: 123456789
   primary_contact: your-login
   auto_ccs: [co-maintainer-login]           # optional, at most 10
   security_contact: security@example.org    # optional: email or https:// URL
   language: go                              # optional
   preset: recommended                       # optional: recommended|strict|agentic|github|insights|all
   ```

   Check the file locally with `npm run cli -- review validate projects/my-project/project.yaml`. The full schema
   is in [`projects/schema.json`](../../projects/schema.json).

4. **Open a pull request** that changes only that one file. The
   [submission template](../../.github/PULL_REQUEST_TEMPLATE/review-submission.md) has a checklist; add
   `?template=review-submission.md` to the compare URL to use it. The **Review intake** check validates the
   submission and reviews the repository. Because you are an outside contributor, a maintainer may need to approve
   the workflow run first. A trusted follow-up job then repeats the checks from the default branch, posts the
   results as a comment on the pull request, and sets the **`review-intake/trusted`** commit status. That status is
   the one that must pass.

5. A code owner reviews and merges the pull request. After that, the project is reviewed every day.

## Acceptance criteria

The `review-intake/trusted` status blocks a submission unless every one of these holds:

| Requirement | Why |
| --- | --- |
| The pull request changes exactly one file, `projects/<name>/project.yaml`. Renames, extra files, and more than one project are rejected. | Keeps each change reviewable and attributable. |
| `project.yaml` passes the strict schema: at most 8 KB, a single YAML document, no unknown keys, no anchors, aliases, merge keys, tags, or duplicate keys, and `name` equals the directory name. | The file is untrusted input. |
| The repository with `repository_id` is public, not a fork, not archived, and not disabled, and its current `owner/repo` equals `main_repo`. | Rejects typosquats, renames, and transfers. |
| The consent file exists on the default branch with this `registry` and `project`. | The repository opts in itself. |
| `primary_contact`, every `auto_ccs` login, **and the pull request author** are listed in `contacts`. | Only consenting maintainers can register the project, and only consenting people are mentioned. |
| Changing or removing an existing project must be done by one of its current contacts, and `repository_id` cannot change. | Prevents hijacking an existing project. |
| An author may have at most 3 other open submission pull requests. | Limits spam. |

Merging is still a human decision. Like OSS-Fuzz, maintainers may decline projects without enough users or
activity, or repositories without CI/CD configuration to review.

## The consent file

`.github/ci-cd-optimizer-review.yml` must be at most 4 KB and is parsed with the same strict rules as
`project.yaml`. It is read again at the default branch's current commit **on every review**, including the
daily re-reviews.

| Key | Meaning |
| --- | --- |
| `registry` | `MSFT-TKENDRICK/ci-cd-optimizer` (compared case-insensitively). Naming the registry stops a consent file written for one registry from being reused by another. |
| `project` | The registered project name. A repository can therefore consent to exactly one registration. |
| `contacts` | 1 to 50 GitHub logins. Only these people can submit or change the project, and only they are mentioned in its reports. |

The program does not ask GitHub whether the submitter has write access to your repository. The collaborator
permission API requires push access to the target repository, and the program's read-only token does not have
it. Instead, the consent file is the proof: only someone who can push to your default branch can create or change
it.

## What you get

- **On the submission pull request:** a comment with the review status and the CI/CD findings from your default
  branch, as a table of severity, rule, location, message, and suggested fix, with links to the rule docs. Each
  new push to the pull request updates the same comment.
- **Daily:** the [daily workflow](../../.github/workflows/cicd-optimizer-daily.yml) re-reviews every registered
  project. The summary appears in the
  [Actions tab](https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/actions/workflows/cicd-optimizer-daily.yml), and
  each project's public report is published as signed JSON (see [below](#verifying-signed-results)).
- **On demand:** run the same review yourself with full detail, including the findings that public reports
  withhold:

  ```sh
  git clone https://github.com/MSFT-TKENDRICK/ci-cd-optimizer && cd ci-cd-optimizer && npm ci
  GITHUB_TOKEN=$(gh auth token) npm run cli -- review run projects/<name>/project.yaml
  ```

  Or run the linter continuously in your own CI with the [GitHub Action](../../README.md#three-ways-to-run-it).

The review respects your repository's own `.github/ci-cd-optimizer.yml`, including `ignorePaths`, rule settings,
and inline suppressions. A `preset` in `project.yaml` replaces the `extends` list from that file. Each review reads
at most 200 files of at most 200 KB each, and the report says when it covered only part of the repository.

## Verifying signed results

Each daily run uploads a `review-reports` artifact with one public (redacted) JSON report per project, named
`<project>.json`, and keeps it for 90 days. A separate job signs every report with a
[build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)
through Sigstore. The attestation binds the file's SHA-256 digest to this repository, the
`review-scheduled.yml` workflow (the signer even when the daily workflow calls it), the commit it ran from, and a
GitHub-hosted runner. Anyone can therefore check
that a report they were given is the program's own, unmodified output and not a copy someone edited:

```sh
# The newest run on main that signed its reports, even if another job in that run failed.
RUN=$(gh api "repos/MSFT-TKENDRICK/ci-cd-optimizer/actions/artifacts?name=review-attestation&per_page=100" --jq '
  [.artifacts[] | select((.expired | not) and .workflow_run.head_branch == "main"
    and .workflow_run.head_repository_id == .workflow_run.repository_id)]
  | max_by(.created_at) | .workflow_run.id')
gh run download "$RUN" --repo MSFT-TKENDRICK/ci-cd-optimizer -n review-reports -D reports
gh attestation verify reports/<project>.json \
  --repo MSFT-TKENDRICK/ci-cd-optimizer \
  --signer-workflow MSFT-TKENDRICK/ci-cd-optimizer/.github/workflows/review-scheduled.yml@refs/heads/main \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

The signer workflow's `@refs/heads/main` pins the reusable workflow's branch; `--source-ref` independently pins
the caller's source branch. Verification fails if a single byte of the report changed, either branch differs,
the signing workflow differs, or the runner is self-hosted. The attestation is also listed on the repository's
[Attestations page](https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/attestations). To verify offline, download
the `review-attestation` artifact from the same run and add `--bundle <file>.jsonl`.

The signature proves where a report came from, not that its findings are complete: it is still a public report,
so sensitive findings are counts only. Submission pull request comments are not signed, because they come from
`pull_request` runs whose workflow file the submitter controls.

## Security-sensitive findings and disclosure

Some findings describe weaknesses that an attacker could exploit, such as unpinned third-party actions or
container images, untrusted input reaching privileged workflows, `pull_request_target`, overly broad permissions,
or exposed secrets and tokens. **Public reports show only the number of these findings and the number of rules
that raised them.** Their details are never posted in public comments or job summaries.

- Maintainers get the details privately with `npm run cli -- review run` (above), or by asking through this
  repository's [private vulnerability reporting](https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/security/advisories/new).
- If registry maintainers find a serious issue while working on the program, they will report it privately to the
  `security_contact` or through your repository's private vulnerability reporting. Disclosure follows the OSS-Fuzz
  model: details stay private until a fix is released or **90 days** have passed, whichever comes first, with a
  14-day grace period when a fix is close.
- Never put secrets in `project.yaml` or the consent file. Both are public.

## Changing, pausing, or leaving the program

| You want to… | Do this |
| --- | --- |
| Change contacts, preset, or language | Open a pull request that modifies `projects/<name>/project.yaml`. You must be a current contact. Add any new contacts to the consent file first. |
| Pause reviews | Set `paused: true` in `project.yaml`. Paused projects are skipped: no API reads, no lint, no report. |
| Leave immediately | Delete `.github/ci-cd-optimizer-review.yml` from your default branch. The next review fails consent and reports nothing about your files. |
| Remove the registration | Open a pull request that deletes `projects/<name>/project.yaml`. You must be a current contact. If you no longer can be, delete the consent file and ask a registry maintainer to remove the entry. |
| Renamed or transferred the repository | Reviews stop with a consent failure that names the new `owner/repo`. Update `main_repo` in a pull request; `repository_id` stays the same. |

Questions and problems: open an issue in this repository. Security reports: use
[private vulnerability reporting](https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/security/advisories/new).
