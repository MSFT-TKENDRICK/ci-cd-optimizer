# Research: Intake / Onboarding Standards for "Submit-a-PR, Get Reviewed" OSS Programs

**Purpose:** Survey programs where open-source projects onboard themselves by submitting a PR to a central repository, in order to inform the design of a GitHub-Actions-based "OSS-Fuzz-like" intake program for a CI/CD workflow linter (`projects/<name>/project.yaml`).

**Methodology note:** Facts below come from a combination of direct primary-source reads (GitHub API file contents, rendered docs pages) and, where tooling access was restricted, AI-assisted web search that itself cites and quotes primary sources. Every fact has an inline citation. Where a fact could only be corroborated via secondary synthesis rather than a byte-for-byte primary read, it is flagged as **(secondary)**.

---

## 1. Google OSS-Fuzz

### Submission file format
A new project submission starts as a PR adding `projects/<project_name>/project.yaml`; once accepted, the project is configured with a `Dockerfile` and `build.sh` in the same directory per the New Project Guide. The project name "can only contain alphanumeric characters, underscores(_) or dashes(-)" [Accepting New Projects](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/).

`project.yaml` fields, per the [New Project Guide](https://google.github.io/oss-fuzz/getting-started/new-project-guide/):

| Field | Required? | Purpose |
|---|---|---|
| `homepage` | required | Project homepage URL |
| `language` | required | Primary language |
| `primary_contact`, `auto_ccs` | required | Contacts CC'd on new bugs; each gets ClusterFuzz dashboard access (crash reports, fuzzer stats) and must use a Google account for full access |
| `main_repo` | required | Path to source repo, e.g. `https://path/to/main/repo.git` |
| `vendor_ccs` | optional | Downstream vendor emails to also receive bug access |
| `sanitizers` | optional | e.g. `address`, `memory` (supports `experimental: True` sub-flag) |
| `architectures` | optional | e.g. `x86_64`, `i386` |
| `fuzzing_engines` | optional | Defaults to `libfuzzer`, `afl`, `honggfuzz`, `centipede`; `libfuzzer` is mandatory |
| `help_url` | optional | Custom help link |
| `builds_per_day` | optional | Up to 4/day; defaults to 1 |
| `file_github_issue` | optional | Mirror bugs to GitHub Issues instead of only the OSS-Fuzz tracker |
| `disable_remediation` / `disable_remediation_pre_review` | optional | Opt out of AI-proposed fix remediation |

`Dockerfile` defines the build container (based on `gcr.io/oss-fuzz-base/base-builder`); `build.sh` runs inside that container and must place compiled fuzz targets into `$OUT`, using provided env vars `$SRC`, `$CFLAGS`/`$CXXFLAGS`, `$LIB_FUZZING_ENGINE` [New Project Guide](https://google.github.io/oss-fuzz/getting-started/new-project-guide/).

### Acceptance criteria
> "To be accepted to OSS-Fuzz, an open-source project must have a significant user base and/or be critical to the global IT infrastructure."
[Accepting New Projects](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/)

### Maintainer consent / ownership proof
The `primary_contact` email must "belong to an established project committer (according to VCS logs)"; if it differs from VCS history, OSS-Fuzz requires "an informal email verification," and the address must be tied to a Google account for dashboard access [Accepting New Projects](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/). There is no CLA; verification is VCS-log cross-reference + informal email confirmation.

### Disclosure policy
Following [Google's standard 90-day disclosure policy](https://googleprojectzero.blogspot.com/2015/02/feedback-and-data-driven-updates-to.html), per the [Bug Disclosure Guidelines](https://google.github.io/oss-fuzz/getting-started/bug-disclosure-guidelines/):
- Issues are opened to the public **90 days** after notifying project authors, **or after a fix is released, whichever is earlier**.
- A deadline landing on a weekend moves to the next work day.
- A **14-day grace period** applies if, before the 90-day deadline, maintainers confirm a patch is scheduled within 14 days.

### How feedback/bugs are delivered
Bugs are auto-filed in the OSS-Fuzz issue tracker (`bugs.chromium.org/p/oss-fuzz`) with CC'd contacts auto-notified, and can optionally mirror into GitHub Issues via `file_github_issue` [New Project Guide](https://google.github.io/oss-fuzz/getting-started/new-project-guide/); [Accepting New Projects](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/). Visibility is restricted until the disclosure deadline logic above resolves it to public.

### Continuous re-review after acceptance
**CIFuzz** — "a GitHub action/CI job that runs your fuzz targets on pull requests… similarly to running unit tests in CI," catching regressions before merge into the *project's own* repo [Continuous Integration](https://google.github.io/oss-fuzz/getting-started/continuous-integration/). OSS-Fuzz itself also continuously fuzzes accepted projects in its central infra at the configured `builds_per_day` cadence.

**AI-proposed patches (beta, "CodeMender")** — Google DeepMind's CodeMender agent proposes fixes for a subset of memory-safety C/C++ bugs; patches are tested in isolation to confirm they compile and fix the crash, and during beta every candidate is reviewed by a human "patch shepherd" before being sent; opt-out via `disable_remediation` or a project's stated submission policy [AI Patches (beta)](https://google.github.io/oss-fuzz/ai-patches-beta/) (secondary-corroborated).

### Removal / opt-out
No explicit "remove my project" doc page was found in the fetched set; the mechanically implied route is a PR deleting `projects/<name>/`. Partial opt-outs exist for remediation (`disable_remediation*` fields). **(gap — not directly verified)**

### CI validation of submission PRs
Verified directly from [`.github/workflows/` in google/oss-fuzz](https://github.com/google/oss-fuzz/tree/master/.github/workflows):
- **`project_tests.yml`** — triggers on PR; actually builds the changed project (`infra/ci/build.py`) across a matrix of engines (`libfuzzer`, `afl`, `honggfuzz`, `centipede`, `none`) × sanitizers (`address`, `memory`, `undefined`, `coverage`) × architectures (`x86_64`, `i386`).
- **`presubmit.yml`** — repo-wide lint/format/structure checks (`infra/presubmit.py`).
- **`check_base_os.yml`** — for PRs touching `projects/**`, verifies Dockerfile base-OS consistency per changed project.

So every submission PR's Dockerfile/build.sh is actually built and fuzz-target-smoke-tested before a human merges it.

### Security handling of untrusted PRs
Submitted Dockerfiles/build.sh execute inside GitHub-hosted (or Cloud Build) ephemeral containers as part of the above CI checks. No additional disclosed sandboxing (e.g., network egress restriction, non-standard isolation) beyond standard Docker/CI-runner containment and mandatory human maintainer review before merge was found in the docs read. **(gap — unverified whether extra sandboxing like gVisor or network-restricted builders is used)**

### ClusterFuzzLite — in-repo CI alternative
> "ClusterFuzzLite is a continuous fuzzing solution that runs as part of Continuous Integration (CI) workflows… With just a few lines of code, GitHub users can integrate ClusterFuzzLite into their workflow and fuzz pull requests to catch bugs before they are committed." It is "based on ClusterFuzz."
[clusterfuzzlite README](https://github.com/google/clusterfuzzlite) / [docs](https://google.github.io/clusterfuzzlite/)

Runs entirely in the submitter's **own** CI (GitHub Actions, GitLab, Cloud Build, Prow) rather than Google's central infra — it's the self-service alternative for projects that aren't (yet) centrally onboarded, supporting C, C++, Java/JVM, Go, Python, Rust, Swift.

### oss-fuzz-gen
> "A Framework for Fuzz Target Generation and Evaluation… generates fuzz targets for real-world C/C++/Java/Python projects with various Large Language Models (LLM) and benchmarks them via the OSS-Fuzz platform."
[oss-fuzz-gen README](https://github.com/google/oss-fuzz-gen), [Google Security Blog](https://security.googleblog.com/2023/08/ai-powered-fuzzing-breaking-bug-hunting.html)

---

## 2. OpenSSF Ecosystem

### OpenSSF Scorecard
Not PR-submission based — adopted as a **GitHub Action in the project's own CI**, a CLI, or consumed via the public **continuous monitor** that crawls a large corpus of popular repos on a recurring cadence and republishes scores via `api.scorecard.dev` [scorecard.dev](https://scorecard.dev/); [ossf/scorecard](https://github.com/ossf/scorecard).

~18 checks scored 0–10, weighted by risk tier (Critical/High/Medium/Low) [checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md):
- **Dangerous-Workflow** (Critical): flags (a) `pull_request_target`/`workflow_run` workflows that check out and run untrusted PR code with elevated token/secrets, and (b) script injection via untrusted inputs interpolated into `run:` steps, and (c) logging of secrets/GitHub context — *"untrusted code checkouts, logging github context and secrets, or use of potentially untrusted inputs in scripts"* [Dangerous-Workflow docs](https://github.com/ossf/scorecard/blob/main/docs/checks.md#dangerous-workflow).
- **Token-Permissions** (High): rewards an explicit, minimal top-level `permissions:` block (e.g. `contents: read`) with elevated write scopes granted only at job level where needed; penalizes missing workflow-level defaults.
- **Pinned-Dependencies** (High): rewards dependencies/actions pinned to immutable refs (commit SHA / digest) rather than mutable tags/branches, across Dockerfiles, shell scripts, Actions `uses:`, and package manifests.

Re-evaluated continuously: per-CI-run for self-hosted use, and on a recurring (weekly) crawl for the public monitor — i.e., crawl-based, not submission-gated.

### Criticality Score
Measures ecosystem **importance/influence** (prioritization signal, not security posture), via a weighted-signal formula over GitHub metadata (contributor/org count, commit frequency, dependents, releases, etc.); computed from mined data, not self-reported [ossf/criticality_score](https://github.com/ossf/criticality_score); [OpenSSF blog](https://openssf.org/blog/2023/07/28/understanding-and-applying-the-openssf-criticality-score-in-open-source-projects/).

### OpenSSF Best Practices Badge (formerly CII Best Practices Badge)
**Self-assessment via web form**, not a PR: maintainer logs in (commonly GitHub OAuth), adds the project, and answers each criterion Met/Unmet/N/A; some criteria get automated pre-checks (robot icon) but final certification is self-declared [bestpractices.dev](https://www.bestpractices.dev/en); [criteria](https://www.bestpractices.dev/en/criteria). Three levels: **Passing**, **Silver**, **Gold** (increasing rigor; Gold generally needs multi-org governance). No forced re-evaluation — maintainers update answers voluntarily.

### Allstar
Opt-in **GitHub App** installed at org or repo level, configured via a dedicated `.allstar` config in the org [ossf/allstar README](https://github.com/ossf/allstar). Policies: **Branch Protection**, **Binary Artifacts**, **Outside Collaborators**, **Dangerous Workflow** (same risk class as Scorecard's check). Two modes per policy: **notify-only** (opens a GitHub issue recording the finding) or **enforce** (actively reverts/restores the secure setting) [OpenSSF blog launch post](https://openssf.org/blog/2021/08/11/introducing-the-allstar-github-app/).

### SLSA (Supply-chain Levels for Software Artifacts)
**No central submission/registry** — fully self-attested: a project's build pipeline emits a signed in-toto/SLSA provenance attestation (source repo/revision, build env, artifact digests), published alongside release artifacts; consumers independently verify the attestation and claimed level with tools like `slsa-verifier`, rather than applying to a central authority [slsa.dev](https://slsa.dev/); [slsa-verifier](https://github.com/slsa-framework/slsa-verifier).

### Alpha-Omega
Structured seasonal/quarterly **grant application**, not pure invitation: Month 1 lightweight intake form → Month 2 review + co-designed Statement of Work with Alpha-Omega staff → Month 3 funding decision. Eligible: standalone OSS projects, foundations, or core ecosystem infrastructure under an OSI-approved license, evaluated on ecosystem security impact [alpha-omega.dev "How to Apply"](https://alpha-omega.dev/grants/how-to-apply/); [ossf/alpha-omega README](https://github.com/ossf/alpha-omega/blob/main/README.md).

### GitHub Private Vulnerability Reporting / Security Advisories
Maintainers enable via repo **Settings → Security → Private vulnerability reporting** (customizable via `.github/VULNERABILITY_REPORT.yml`) [Configuring private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). Reporters use the repo's Security tab → "Report a vulnerability" form, creating a **draft security advisory**; reporter is added as a collaborator on the private draft, optionally with a temporary private fork to develop a fix [Privately reporting a vulnerability](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately). Publishing assigns a **GHSA ID** (optionally requesting a CVE) and makes it public in the GitHub Advisory Database — report-private-then-disclose, with no GitHub-mandated universal embargo timeline (projects set their own via SECURITY.md) [Coordinated disclosure overview](https://docs.github.com/en/code-security/reporting-security-vulnerabilities/about-coordinated-disclosure).

---

## 3. Formal Verification Registries

### model-checking/verify-rust-std — "Challenges"
Challenges are tracked docs at `book/src/challenges/<ID>-<name>.md`, built from a required template [general-rules.md](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/general-rules.md):
1. Open a tracking issue using the "challenge template."
2. Copy `book/src/challenge_template.md` → `book/src/challenges/<ID>-<name>.md`.
3. Add a link in `book/src/SUMMARY.md`.
4. Submit a PR; once approved by committee, the tracking issue is labeled "Challenge."

Required template fields ([challenge_template.md](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/challenge_template.md)): `Status` (Open/Resolved/Expired), `Solution` (optional PR link), `Tracking Issue`, `Start date`, `Reward`, plus `Goal`/`Motivation`/`Description` (with `Assumptions`, `Success Criteria`).

### model-checking/verify-rust-std — Tool approval
Solutions must use a tool from the "Approved Tools" list; adding a new tool requires an **application**, reviewed by committee [general-rules.md §Tool Applications](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/general-rules.md):
1. Open an issue with the "Tool Application" template.
2. Committee reviews; on approval, submitter opens a PR adding a new CI workflow running the tool against the stdlib + a new "Approved Tools" entry.
3. Once merged, the tool is "integrated"; approval can later be **revoked** if its CI workflow breaks and isn't fixed.

Tool template fields ([tool_template.md](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/tool_template.md)): Tool Name, Description, capability checkboxes (Rust verification? handles unsafe? runs independently in CI? open source? under development? supportable?), Comparison to other approved tools, License (checked for conflicts with the Rust stdlib license), Steps to Use, Artifacts & Audit Mechanisms, Versioning, CI.

### sosy-lab/sv-benchmarks (SV-COMP)
Task-definition `.yml` format v2.0 (extends the [task-definition-format 2.0 spec](https://gitlab.com/sosy-lab/benchmarking/task-definition-format/-/tree/2.0)), per [README.md](https://github.com/sosy-lab/sv-benchmarks/blob/main/README.md):
- `format_version: '2.0'`
- `input_files`: program file(s)/dir
- `properties`: list of `{property_file, expected_verdict (true/false), subproperty (optional)}`
- `options`: `language` (e.g. `C`), `data_model` (e.g. `ILP32`, `LP64`)

Validated programmatically by [`c/check.py`'s `TaskDefinitionFileChecks`](https://github.com/sosy-lab/sv-benchmarks/blob/main/c/check.py) (cross-checks `data_model` against the directory's `Makefile`-declared architecture; directories must have a `Makefile`).

**License**: every file needs an SPDX header per the [REUSE Specification](https://reuse.software/spec/); license must permit viewing, modifying, redistributing, compiling, and **commercial use** ("to not exclude developers of commercial verifiers"); Apache-2.0/GPL preferred; custom `LicenseRef-$NAME` licenses require a `LICENSES/LicenseRef-$NAME.txt` file; GPL-derived tasks must stay GPL [CONTRIBUTING.md §License](https://github.com/sosy-lab/sv-benchmarks/blob/main/CONTRIBUTING.md).

**Review**: fork → PR → "discuss with community members until your contribution is approved and merged"; contributors must run `c/check.py` and resolve `ERROR`s, whitelisting intentional exceptions in `KNOWN_*_PROBLEMS` lists [CONTRIBUTING.md](https://github.com/sosy-lab/sv-benchmarks/blob/main/CONTRIBUTING.md).

### VerifyThis Long-Term Challenge
No PR/registry mechanism comparable to the above was found. Participants **register** with organizers and join the mailing list `verifythis-ltc@lists.kit.edu`; there's no fixed deadline or formal submission template — progress is shared informally via mailing list / venue meetings (ISoLA/ETAPS) [VerifyThis LTC site](https://verifythis.github.io/ltc/) **(secondary)**. The separate onsite **VerifyThis@ETAPS** competition has teams push solutions to per-team private GitHub repos before a live deadline [Challenges – VerifyThis](https://verifythis.github.io/onsite/challenges/); [VerifyThis2025 org](https://github.com/VerifyThis2025) **(secondary)**.

---

## 4. GitHub Actions Security Guidance (Pwn Requests / Untrusted PR Handling)

### "Preventing pwn requests" (GitHub Security Lab)
[Part 1: Preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/):
- A **"pwn request"** occurs when a workflow trigger that runs with elevated trust/privilege (classically `pull_request_target`, which grants a write-scoped `GITHUB_TOKEN` and full secrets access even for fork PRs) checks out and executes the *untrusted* PR head code — handing attacker-controlled code the privileged token and secrets.
- `pull_request` (default): runs the workflow **definition from the base branch** but with a read-only/limited token and no secrets for fork PRs — safe for building/testing untrusted code.
- `pull_request_target`: runs with the base repo's trust/privileges regardless of PR origin — dangerous if it also checks out and executes the PR's head commit (e.g., `ref: ${{ github.event.pull_request.head.sha }}` then `run: ./test.sh`).
- **Recommended two-phase pattern**: Phase 1 (`pull_request`-triggered, unprivileged) builds/tests/lints the untrusted code with no secrets, producing artifacts/outputs only. Phase 2 (`workflow_run`-triggered, privileged) runs only after phase 1 completes, **never checks out or executes the PR's code**, and instead consumes only the artifact/output data from phase 1 to perform privileged actions (status updates, labeling, comments, publishing).
- **TOCTOU caveat**: if the privileged phase re-resolves the PR by branch name rather than the exact reviewed SHA, new commits pushed after review but before the privileged run could slip in unreviewed — mitigate by pinning to the exact reviewed commit SHA.
- Recent platform hardening (2026) reduces the default risk: `actions/checkout@v7`+ now refuses fork-PR-head checkouts by default inside `pull_request_target`/PR-triggered `workflow_run` jobs unless explicitly overridden [Safer pull_request_target defaults](https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/), and a "Workflow execution protections" feature lets maintainers restrict what can trigger sensitive workflows [Workflow execution protections GA](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/).

### GitHub Docs: Security hardening for GitHub Actions
[Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions) / [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target):
- Reiterates the `pull_request_target` risk and the checkout-avoidance mitigation above.
- **Script injection mitigation**: don't interpolate untrusted expressions (e.g. `${{ github.event.issue.title }}`) directly into a `run:` shell step (shell-metacharacter injection risk); instead pass through an intermediate `env:` variable and reference it as `$VAR_NAME` in the script, which goes through the runner's environment mechanism rather than raw template substitution.
- **Least privilege**: set an explicit top-level `permissions:` block (e.g. `contents: read`) rather than relying on repo-wide defaults, elevating only specific jobs/steps that need write scopes (e.g. `pull-requests: write`) — [workflow syntax `permissions`](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions).

### Artifact poisoning (companion risk to the two-phase pattern)
The two-phase pattern itself has a known weak point: if the privileged phase 2 job blindly downloads and extracts/executes an artifact uploaded by the untrusted phase 1 job, the attacker can smuggle a payload across the trust boundary via the artifact instead of via code checkout. Documented as a built-in medium-severity CodeQL Actions query: [CodeQL query help: Artifact poisoning](https://codeql.github.com/codeql-query-help/actions/actions-artifact-poisoning-medium/); related guidance in [GitHub Blog: Secure your GitHub Actions workflows with CodeQL](https://github.blog/security/application-security/how-to-secure-your-github-actions-workflows-with-codeql/) and the [OWASP GitHub Actions Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html). Mitigations: treat artifact filenames/content as attacker-controlled (reject path traversal/"zip-slip"); extract only into isolated temp dirs, never the repo workspace; never execute scripts/binaries sourced from the artifact — validate structure/schema and read only specific declared fields instead.

---

## 5. Other PR-Based Registries

### CNCF Landscape
PR adds an entry to top-level `landscape.yml` (`name`, `homepage_url`, `repo_url`, `logo`, `crunchbase`, category/subcategory; CNCF-hosted projects add `project` maturity stage + `accepted` date) plus an SVG logo in `hosted_logos/` [landscape.yml](https://github.com/cncf/landscape/blob/master/landscape.yml); [data schema](https://raw.githubusercontent.com/cncf/landscape2/refs/heads/main/docs/config/schema/data.schema.json). Non-member/non-CNCF entries need meaningful GitHub traction; automated GitHub Actions validate YAML schema, required fields, logo presence/format, and link validity before merge is possible **(secondary)**.

### Homebrew Acceptable Formulae
Notability thresholds, per [Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae): ordinary submissions need **≥30 forks, 30 watchers, or 75 stars**; self-submissions (repo owner/author with verified matching domain email) need **≥90 forks, 90 watchers, or 225 stars**. Must be actively maintained, no unpatched known CVEs, public homepage, stable/tagged releases only, DFSG-compatible open-source license [Package Acceptance Policy](https://docs.brew.sh/Package-Acceptance-Policy). CI: `brew test-bot` runs the full build/bottle/test matrix (macOS + Linux) on every PR, gating merge [BrewTestBot for Maintainers](https://docs.brew.sh/BrewTestBot-For-Maintainers).

### DefinitelyTyped
New package at `types/<package-name>/`: `index.d.ts`, `package.json` (`name: @types/<pkg>`, `version`, dependencies on other `@types/*`), `tsconfig.json`, and a `<package-name>-tests.ts` usage test [CONTRIBUTING.md](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/CONTRIBUTING.md). Ownership metadata lives in `package.json` (`owners` with GitHub usernames, `projects` URLs); the older `// Definitions by:` header comments were retired in favour of these fields [README](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/README.md). CI: `dtslint`/successor tooling lints and type-checks every PR [DefinitelyTyped-tools](https://github.com/microsoft/DefinitelyTyped-tools). "Mergebot" automates status checks and auto-merge once CI passes and review conditions are met; the listed `owners` become the listed/notified maintainer(s) consulted on future related PRs.

### conda-forge staged-recipes
PR to [conda-forge/staged-recipes](https://github.com/conda-forge/staged-recipes) adds `recipe/meta.yaml` (name, version, source, build, requirements, test, about, extra). The `extra.recipe-maintainers` list **must name the GitHub usernames who consent to maintain** the resulting feedstock (this is the up-front consent mechanism) [staged-recipes README](https://github.com/conda-forge/staged-recipes/blob/main/README.md). An automated linter bot comments on `meta.yaml` convention issues; CI builds the recipe across platforms before merge. Post-merge, `conda-smithy` auto-generates a new `<package>-feedstock` repo, wiring CI and granting the listed maintainers push access there for future updates.

### Flathub
PR to [flathub/flathub](https://github.com/flathub/flathub) (against the `new-pr` branch) adding the Flatpak manifest + metadata; PR title includes the app ID [Submission docs](https://docs.flathub.org/docs/for-app-authors/submission). **Ownership/consent proof required before publishing**: domain verification (a token file at `https://yourdomain.com/.well-known/org.flathub.VerifiedApps.txt` or a `_flathub.yourdomain.com` DNS TXT record), **or**, for reverse-DNS IDs tied to a hosting service (`io.github.*`, `io.gitlab.*`), authenticating with that host to prove admin/owner rights [Verification docs](https://docs.flathub.org/docs/for-app-authors/verification). CI automatically builds the app from the manifest; reviewers additionally check sandbox permissions (justification required for anything extending outside the sandbox), licensing, and screenshots before merge/publish.

### Renovate presets
Decentralized, **not** a central-repo PR-submission model: presets are shared as npm packages or org-level `renovate-config` repos and referenced by name (`github>org/repo`), rather than being reviewed/merged into one canonical registry [docs.renovatebot.com/presets-default](https://docs.renovatebot.com/presets-default/) **(secondary, included for completeness/contrast)**.

---

## Patterns to Adopt

Drawing on the above, the following recurring design patterns are directly applicable to a `projects/<name>/project.yaml` PR-based intake program for a workflow linter:

1. **Minimal, schema-validated metadata file** (OSS-Fuzz `project.yaml`, CNCF `landscape.yml`, conda-forge `meta.yaml`, Flathub manifest, SV-COMP task-definition YAML): require a small set of mandatory fields (project name, homepage, repo URL, primary contact, language) plus optional fields (CC list, custom options), validated by a schema checker that runs as a required CI check on every PR — never by eyeballing alone.

2. **Self-listed maintainers as the consent mechanism** (conda-forge `recipe-maintainers`, OSS-Fuzz `primary_contact`/VCS cross-check, DefinitelyTyped `owners`): require the PR to name the GitHub handle(s) who consent to being contacted/responsible, and cross-check that the submitter (or named maintainer) actually has commit history or domain/host-ownership ties to the target repo — Flathub's domain-verification-or-host-OAuth-ownership model and OSS-Fuzz's VCS-log check are the two strongest concrete patterns for proving "this person really represents the project," important since you're accepting workflow-linting findings for someone else's repo.

3. **Build/validate the submission itself in CI before merge** (OSS-Fuzz `project_tests.yml` building the Dockerfile/build.sh across a matrix; Homebrew's `brew test-bot`; Flathub's build-from-manifest; conda-forge's linter bot; SV-COMP's `check.py` sanity checks): the submission PR should trigger an automated job that actually exercises what's being submitted (e.g., run the linter against the target repo, confirm `project.yaml` resolves to a real, accessible repo) and report pass/fail as a required status check — not just schema validation.

4. **Two-phase trust separation for CI on untrusted PR content** (GitHub Security Lab's pwn-request pattern): because `project.yaml` submissions point at *external* repos that your CI will then clone/scan, treat the submission PR itself as from an untrusted party. Use `pull_request` (not `pull_request_target`) for any phase that clones/executes code related to the submission, with zero secrets and a read-only token; if a privileged action is needed afterward (e.g., commenting with results, writing to a central index, filing a tracking issue), split it into a separate `workflow_run`-triggered job that consumes only validated/structured output (e.g., a JSON lint report) — never raw code or arbitrary artifacts — from the first phase, and validate/sanitize that artifact (schema-check it, reject path traversal) before use, per the artifact-poisoning mitigations above.

5. **Restricted/staged visibility with a disclosure clock for security-relevant findings** (OSS-Fuzz 90-day + 14-day grace; GitHub private vulnerability reporting's draft-advisory-then-publish flow): if the linter surfaces exploitable CI/CD misconfigurations (e.g., a pwn-request pattern in the target project's own workflows), treat that finding like a security bug — private disclosure to the project's listed maintainer first, with a defined (e.g., 90-day) deadline before any public listing/scoring, rather than immediately publishing results.

6. **Separate "central intake" from "continuous re-check"** (OSS-Fuzz project.yaml PR vs. CIFuzz/ClusterFuzzLite running in the target's own CI; Scorecard's one-time Action-adoption vs. its continuously-recrawled public monitor): offer both (a) a central registry entry via PR (your `project.yaml`) that triggers periodic re-scans from your infra, and (b) a lightweight "run it yourself in your own CI" mode (à la ClusterFuzzLite) for projects that want continuous feedback without waiting on/depending on central infrastructure.

7. **Tiered self-certification with partial automation** (OpenSSF Best Practices Badge's Passing/Silver/Gold self-assessment with robot-assisted pre-checks; Scorecard's weighted-by-risk-tier scoring): consider a scored/tiered output (e.g., Critical/High/Medium/Low findings, an aggregate 0–10 score) rather than a binary pass/fail, so partial compliance is still actionable and comparable across projects — and let some checks be automatically pre-verified while others require explicit maintainer attestation.

8. **Revocable approval, not just one-time acceptance** (verify-rust-std's tool approval revocable if its CI workflow breaks; OSS-Fuzz's build-health implications; Allstar's enforce vs. notify modes): make acceptance conditional on continued passing CI health, with automatic flagging/removal (or demotion to a "stale" state) if the registered project stops building/scanning cleanly, rather than a permanent one-time gate.

9. **Opt-out and removal as first-class, documented paths** (OSS-Fuzz `disable_remediation`, Allstar notify-vs-enforce toggle, Best Practices Badge's voluntary self-update): explicitly document a PR-based (or settings-based) mechanism for a maintainer to adjust their participation level (e.g., disable auto-remediation suggestions, disable a specific check category) or fully remove their project, since this is a known gap even in OSS-Fuzz's own docs.

---

## Comparison Table

| Program | Submission mechanism | Required file/fields | Acceptance criteria | Consent/ownership proof | Feedback delivery | Continuous re-review | Disclosure timeline | CI validates submission | Untrusted-PR security model |
|---|---|---|---|---|---|---|---|---|---|
| **OSS-Fuzz** | PR adding `projects/<name>/project.yaml` (then `Dockerfile`, `build.sh`) | `homepage`, `language`, `primary_contact`, `main_repo` (+optional `sanitizers`, `fuzzing_engines`, etc.) | Significant user base or critical to global IT infra | VCS-log cross-check on `primary_contact`; informal email verification if mismatched | Auto-filed bugs in OSS-Fuzz tracker, optional GitHub issue mirror | CIFuzz (PR-time) + central fuzzing at `builds_per_day` | 90 days + 14-day grace | Yes — builds project across engine/sanitizer/arch matrix (`project_tests.yml`) | Builds submitted Dockerfile/build.sh in CI runner; human merge review; no disclosed extra sandboxing found |
| **ClusterFuzzLite** | N/A (library integrated into submitter's own CI) | CI workflow config in submitter's repo | Self-service, no gate | N/A (runs under submitter's own CI permissions) | Local PR check failures/crash artifacts | Every PR + scheduled batch fuzzing | N/A | N/A (runs in submitter's CI) | Entirely submitter-owned trust boundary |
| **OpenSSF Scorecard** | Self-adopted Action, or passively crawled | N/A (analyzes existing repo state) | None — informational scoring | None | Score (0–10) per check + public viewer/API | Every CI run / weekly public crawl | N/A | N/A | Parses metadata/config, minimal code execution |
| **OpenSSF Best Practices Badge** | Self-service web form | Free-text criteria answers | Self-certified; partial auto-check | GitHub OAuth login only | Badge level (Passing/Silver/Gold) + public page | Voluntary maintainer updates | N/A | N/A | No code execution (self-reported) |
| **Allstar** | GitHub App install + `.allstar` config PR | Policy config YAML | Opt-in, no gate | Org admin installs the App | GitHub issues (notify) or auto-fix (enforce) | Continuous (App-driven) | N/A | N/A | Operates with App-scoped permissions on installed repos only |
| **SLSA** | None (self-attestation) | Signed in-toto provenance attestation | None — consumer-verified | Cryptographic signature on attestation | Verification tool output (pass/fail per level) | Per build/release | N/A | N/A | N/A (no third party executes anything) |
| **Alpha-Omega** | Quarterly grant application form | Free-form proposal | Ecosystem security impact, OSI license | Staff-vetted during SOW co-design | Direct technical engagement | Per-engagement | N/A | N/A | N/A |
| **GitHub Private Vuln. Reporting** | Security tab form (not a PR) | Summary/details/PoC/impact | Maintainer discretion | Reporter added as advisory collaborator | Draft GHSA advisory thread | Per report | Maintainer/SECURITY.md-defined | N/A | Private draft repo/fork isolates disclosure |
| **verify-rust-std challenges** | PR adding `book/src/challenges/<id>.md` from template | `Status`, `Tracking Issue`, `Start date`, `Reward`, `Goal`/`Description` | Committee review and approval | Committee-gated | PR review comments; "Challenge" label on issue | Revocable tool approval if CI breaks | N/A | Yes — new tools require a CI workflow proving they run against stdlib | Approved tools run in project's own CI matrix |
| **SV-COMP sv-benchmarks** | PR adding task `.yml` + program files | `format_version`, `input_files`, `properties`, `options` (`language`,`data_model`) | Community discussion/approval; passes `check.py` | Submitter is PR author; license must allow commercial reuse | PR review comments | N/A (benchmark corpus, not re-scanned) | N/A | Yes — `check.py` sanity checks run and must pass | Static files only, no code execution of submissions |
| **VerifyThis LTC** | Mailing-list registration, informal | None formal | None formal | None formal | Ad hoc / meetings | N/A | N/A | No | N/A |
| **CNCF Landscape** | PR editing `landscape.yml` + logo SVG | `name`, `homepage_url`, `repo_url`, `logo`, `crunchbase`, category | Fits category; traction for non-members | None beyond PR review | PR review + CI check comments | Re-reviewed on future PRs only | N/A | Yes — schema/field/logo/link validation | Static YAML, no code execution |
| **Homebrew core** | PR adding a Formula `.rb` | Formula DSL (url, sha256, license, `test do`) | ≥30/30/75 (or 90/90/225 self-submit) forks/watchers/stars; active maintenance, stable release | Self-submitter needs verified domain-matching email | `brew test-bot` CI output + maintainer review | Re-tested on every future PR to the formula | N/A | Yes — full build/bottle/test matrix via `brew test-bot` | Builds/installs submitted formula in CI sandboxed runner |
| **DefinitelyTyped** | PR adding `types/<pkg>/` | `index.d.ts`, `package.json` (with `owners`), `tsconfig.json`, `<pkg>-tests.ts` | Passes dtslint + type-check | `package.json` `owners` are the acknowledged maintainers | Mergebot CI status + reviewer comments | Named maintainer notified of future related PRs | N/A | Yes — dtslint/type-check required status | Type-checks only; no arbitrary code execution of submitted `.d.ts` |
| **conda-forge staged-recipes** | PR adding `recipe/meta.yaml` | `meta.yaml` (name, version, source, build, requirements, test, about, extra) | Linter + CI build pass | `extra.recipe-maintainers` must list consenting GitHub handles | Linter bot inline comments + CI build logs | New feedstock repo re-built on every future update PR | N/A | Yes — conda-forge linter + CI build across platforms | Builds submitted recipe in CI; post-merge isolated feedstock repo |
| **Flathub** | PR adding Flatpak manifest to `new-pr` branch | Flatpak manifest (app ID, sources, permissions) | Passes build + manifest/permission review | Domain verification OR host (GitHub/GitLab) OAuth ownership proof | Reviewer PR comments + automated build status | Future updates via new PRs to same repo | N/A | Yes — automatic build-from-manifest on PR | Builds in Flathub's build system; sandbox-permission justification required for anything extending outside Flatpak sandbox |

---

## Sources (primary fetch where noted; secondary synthesis otherwise flagged inline above)

- Google OSS-Fuzz: [Accepting New Projects](https://google.github.io/oss-fuzz/getting-started/accepting-new-projects/), [New Project Guide](https://google.github.io/oss-fuzz/getting-started/new-project-guide/), [Bug Disclosure Guidelines](https://google.github.io/oss-fuzz/getting-started/bug-disclosure-guidelines/), [Continuous Integration](https://google.github.io/oss-fuzz/getting-started/continuous-integration/), [AI Patches (beta)](https://google.github.io/oss-fuzz/ai-patches-beta/), [`.github/workflows`](https://github.com/google/oss-fuzz/tree/master/.github/workflows), [clusterfuzzlite](https://github.com/google/clusterfuzzlite), [oss-fuzz-gen](https://github.com/google/oss-fuzz-gen)
- OpenSSF: [Scorecard](https://github.com/ossf/scorecard), [checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md), [scorecard.dev](https://scorecard.dev/), [criticality_score](https://github.com/ossf/criticality_score), [bestpractices.dev](https://www.bestpractices.dev/en), [allstar](https://github.com/ossf/allstar), [slsa.dev](https://slsa.dev/), [alpha-omega.dev](https://alpha-omega.dev/grants/how-to-apply/), [GitHub private vulnerability reporting docs](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)
- Formal verification: [verify-rust-std general-rules.md](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/general-rules.md), [challenge_template.md](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/challenge_template.md), [tool_template.md](https://github.com/model-checking/verify-rust-std/blob/main/doc/src/tool_template.md), [sv-benchmarks README](https://github.com/sosy-lab/sv-benchmarks/blob/main/README.md), [sv-benchmarks CONTRIBUTING.md](https://github.com/sosy-lab/sv-benchmarks/blob/main/CONTRIBUTING.md), [VerifyThis LTC](https://verifythis.github.io/ltc/)
- GitHub Actions security: [Preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/), [Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions), [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [CodeQL artifact poisoning query](https://codeql.github.com/codeql-query-help/actions/actions-artifact-poisoning-medium/)
- Other registries: [cncf/landscape](https://github.com/cncf/landscape/blob/master/landscape.yml), [Homebrew Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae), [DefinitelyTyped CONTRIBUTING.md](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/CONTRIBUTING.md), [conda-forge staged-recipes](https://github.com/conda-forge/staged-recipes/blob/main/README.md), [Flathub submission docs](https://docs.flathub.org/docs/for-app-authors/submission), [Flathub verification docs](https://docs.flathub.org/docs/for-app-authors/verification)

---

## Verification notes (registry maintainers, Nov 2026)

Spot-checked before adopting this write-up:

- OSS-Fuzz "Accepting New Projects" — confirmed: the submission PR adds only `project.yaml`; `Dockerfile`/`build.sh` come after acceptance (corrected above).
- GitHub changelog 2026-06-18 "Safer pull_request_target defaults for actions/checkout" and 2026-09-17 "Workflow execution protections GA" — both resolve and match the summary.
- CodeQL `actions/artifact-poisoning/medium` query help — confirmed.
- DefinitelyTyped — ownership metadata moved from `// Definitions by:` headers to `package.json` `owners` (corrected above).
- verify-rust-std paths: the prose says `book/src/` while the cited links point to `doc/src/`; treat the linked paths as authoritative.
- Claims the methodology note describes as secondary synthesis were not re-verified and are not load-bearing for the design.
