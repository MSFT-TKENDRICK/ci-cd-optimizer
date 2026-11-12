# Contributing

Use Node.js 22 and install dependencies with `npm ci`.

Install the mandatory repository-managed gates before committing:

```sh
npm run secrets:install
npm run hooks:install
```

Setup works on Windows (Git for Windows), macOS and Linux. It preserves conflicting hooks/configuration
instead of replacing checks. Review and migrate existing hooks explicitly before retrying.
`core.hooksPath` is repository-local and shared by linked worktrees; each worktree must contain `.githooks`.
No network download or dependency installation runs inside a hook. Rerun `npm ci` after lockfile changes.

Pre-commit runs the staged-index secret scan, ESLint, and this repository's CI/CD Optimizer against the
working tree (`--fail-on error`), in that order. Pre-push scans all available Git history and retains
`ci:check-generated`; shallow clones must fetch full history. Missing tools and failed checks block the operation.
Run `npm run hooks:check` to reproduce the commit gate without committing.
Linting reads the working tree, so keep partially staged lint changes in sync; the secret check reads the index.

`.gitleaks/better-gitleaks` is a repository-owned entry point for **Gitleaks 8.30.1**, not an assumed external
"better-gitleaks" product. `secrets:install` verifies the pinned upstream release's SHA-256 before extraction.
The checked-in `.gitleaks/config.toml` extends all upstream default detectors. Scans redact findings, ignore
ambient `GITLEAKS_*` overrides, and do not accept inline `gitleaks:allow` or `.gitleaksignore` exemptions.
Use `npm run secrets:staged` for the index or `npm run secrets:check` for complete history. Rotate any genuine
exposed credential before removing it; do not hide a finding or add broad allowlists.

Local hooks cannot prevent Git's explicit `--no-verify` or configuration overrides. CI independently runs
the same pinned scanner with full history; repository administrators should require **Secret scanning / secrets**
alongside the existing required checks in branch protection. Never treat a local success as permission to bypass CI.

Before opening a pull request, run:

```sh
npm run lint
npm test
npm run build
npm run assurance:check
npm run formal:setup
npm run formal:check
```

If you change `ui/setup`, run `npm run build:ui` and commit the regenerated `dist-setup/`; CI fails when it is stale.
`npm run preview:mcp` shows the panel in a stand-in MCP Apps host against a fake GitHub (see [docs/setup.md](docs/setup.md)).

New rules belong in `src/lint/rules`, must include focused tests, and should only
report a finding when they can provide concrete evidence and a practical
remediation.

Review each rule's claims and regenerate `formal/rule-assurance.json`, its compiled counterpart, and the reference
with `npm run assurance:generate` and `npm run docs:rules`. A catalogue entry is not a detector/performance proof.
Production source, dependency or proof-tool changes also require `npm run formal:generate`: it verifies the Dafny
models before regenerating the checked-in runtime and source/dependency build stamp. Never hand-edit generated
formal code or bypass a missing solver. [Formal verification](docs/formal-verification.md) specifies the contracts,
the trusted extraction/preprocessing boundary, and certificate checks.

Scheduling-model changes must preserve complete policy-space coverage, feasibility and global optimality over
the declared domain, not only selection among a supplied list. Keep the
[public model schema](formal/ci-environment.schema.json), generated bounds, planning adapter, certificates and
[model guide](docs/ci-policy-planning.md) consistent. Run `test/formal`, including its independent exhaustive
scheduling oracle and CLI/binding regressions; never interpret budget exhaustion as infeasibility or an optimum.
For stale shipped bundles, retrieve hosted CI's `action-bundle-<sha>` / `agent-bundle-<sha>` artifacts and commit
their outputs. CI separately executes the real Action planner/checker and packaged agent transports.

To enroll a repository in the [project review program](docs/review-program/README.md), open a pull request that
touches only `projects/<name>/project.yaml`, using the `review-submission` pull request template. Changes to
`projects/`, `src/review/`, and the review workflows require code owner review.
