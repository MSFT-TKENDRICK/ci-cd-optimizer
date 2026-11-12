# Standalone linter

The rule engine behind the GitHub App also runs on its own, like actionlint, zizmor, hadolint, or ESLint:

- as a dev tool, with `cicd-lint` on a checkout;
- as a CI step, with the GitHub Action or the reusable workflow;
- as a pre-commit hook.

The same built-in rules power [developer-agent skills, MCP, and ACP](agents.md). These read-only interfaces accept
unsaved content and return exact fix previews without writing files or importing repository-local rules.
The ordinary CLI's `--fix` and `--allow-local-rules` are separate, explicit opt-ins; no protocol write API exists.

It reads GitHub Actions workflows, composite actions, Dockerfiles, Nix expressions/flakes, and package/toolchain
configuration. Findings identify declared practices and potential improvements, not proven speedups or universally
equivalent rewrites. The [rule catalog](rules.md) lists every rule; the [Nix guide](nix.md) explains its static model.

- [Quick start](#quick-start)
- [Command line](#command-line)
- [Supported inputs](#supported-inputs)
- [Job dependency success gates](#job-dependency-success-gates)
- [Output formats and editors](#output-formats-and-editors)
- [Configuration](#configuration)
- [Suppressions](#suppressions)
- [Custom local rules](#custom-local-rules)
- [CI](#ci)
- [Git hooks](#git-hooks)
- [Comparison and credit](#comparison-and-credit)

## Quick start

The package is not published to npm yet; its server runtime dependencies (Probot, PostgreSQL) make it a poor
standalone install. Build it from a clone:

```sh
git clone https://github.com/MSFT-TKENDRICK/ci-cd-optimizer
cd ci-cd-optimizer
npm ci && npm run build
npm link                       # puts cicd-lint and ci-cd-optimizer on PATH

cd ~/src/my-service
cicd-lint                      # lint the current directory
cicd-lint --init               # write a starter .github/ci-cd-optimizer.yml
```

You can also install a tarball with `npm pack` in the clone, which builds `dist/` through the `prepack` script, then
`npm install --save-dev ./ci-cd-optimizer-0.2.0.tgz` in your project. Inside this repository, `npm run cli -- lint`
runs the TypeScript sources directly.

`cicd-lint [args]` is shorthand for `ci-cd-optimizer lint [args]`.
`cicd-lint --version` (or `-v`) prints the installed package version.

## Command line

```sh
cicd-lint                                   # lint the current directory
cicd-lint path/to/repo                      # a single directory becomes the lint root
cicd-lint .github/workflows/ci.yml          # report one file
cicd-lint ".github/workflows/*.yml" Dockerfile
cicd-lint --base origin/main                # only findings this change introduces
cicd-lint --fix                             # apply available autofixes; review and test the diff
cat ci.yml | cicd-lint --stdin --stdin-filename .github/workflows/ci.yml
```

**Path arguments filter the report; they do not isolate the analysis.** Many rules compare files with each other.
For example, a Dockerfile rule checks `.dockerignore`, and package rules compare every workspace manifest. So the
whole lint root is always loaded and analyzed, and diagnostics, parse problems, and unused directives are then
filtered to the requested paths. With no arguments the root is the current directory. A single existing directory
argument becomes the root, as in earlier versions. Otherwise each argument is a file, a directory prefix, or a glob
relative to `--root` (default: the current directory). Quote globs so your shell does not expand them.

Requests that match nothing get a notice on stderr and exit 0: a missing path, an ignored file, or a file type the
linter does not read. A file left out because the inventory hit `limits.maxFiles` also gets a notice. `--fix` only
applies fixes for the diagnostics that survive the filter.

| Option | Description |
|---|---|
| `-c, --config <file>` | Configuration file (default: `.github/ci-cd-optimizer.yml` or `.yaml` under the root) |
| `--root <dir>` | Lint root when path arguments are given (default: the current directory) |
| `-f, --format <name>` | `stylish` (default), `json`, `sarif`, `markdown`, `github` |
| `-o, --output <file>` | Write the report to a file instead of stdout |
| `--sarif <file>` | Also write a SARIF 2.1.0 report |
| `--preset <name>` | Replace the configured presets (repeatable) |
| `--rule <id>=<severity>` | Override one rule: `off`, `info`, `warn`, `error` (repeatable) |
| `--ruleset <id>=<severity>` | Override every rule in a ruleset (repeatable) |
| `--fail-on <severity>` | Exit 1 at this severity or above: `info`, `warn`, `error` (default), `never` |
| `--max-warnings <n>` | Exit 1 when more than `n` warnings are reported |
| `--base <ref>` | Compare with a git ref and report only introduced findings |
| `--scope <scope>` | `all`, `changed`, or `introduced` (default: `introduced` with `--base`, else `all`) |
| `--fix` | Apply available autofixes in place; review and test the diff |
| `-q, --quiet` | Report errors only |
| `--stdin` | Lint standard input in place of the file named by `--stdin-filename` |
| `--stdin-filename <path>` | Root-relative path for `--stdin` content; required with `--stdin`; decides which rules apply |
| `--report-unused-disable-directives [warn\|error\|off]` | Report suppression comments that suppressed nothing; off unless given, `warn` when given alone |
| `--allow-local-rules` | Load the configuration's [`localRules`](#custom-local-rules); trusted repositories only |
| `--list-rules` | List rules (`id  severity  fix  description`) and exit |
| `--explain <rule-id>` | Explain a rule and exit |
| `--print-config` | Print the effective configuration and rule severities as JSON and exit |
| `--init` | Write a starter configuration (to `-c <file>` if given) and exit |

`--stdin` content replaces the file of the same name in the inventory, or adds it. Only that path is reported, and it
cannot be combined with `--fix` or with path arguments.

### Supported inputs

The CLI, Git-revision baseline, GitHub App/API scan and Action use the same inventory selection:

| Family | Recognized input |
|---|---|
| Actions | `.github/workflows/*.yml` / `*.yaml`, composite `action.yml` / `action.yaml`, optimizer/Dependabot/Renovate configuration |
| Containers | `Dockerfile` / `Containerfile` and suffixed variants, `*.dockerfile` / `*.containerfile`, `.dockerignore` / `*.dockerignore`, Compose and Bake configuration |
| Nix | `*.nix` (case-insensitive), `flake.lock`, `.envrc`, `devenv.yaml`, `devenv.lock` |
| Packages | Supported Node, Python, Cargo, Go and .NET manifests/locks; `pnpm-workspace.yaml`; `requirements*.txt` and `requirements/*.txt` |
| Toolchains/build tools | `.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, `.go-version`, `.java-version`, `.sdkmanrc`, `rust-toolchain[.toml]`, `.cargo/config[.toml]`, Gradle files/properties/wrapper properties, Bazel files/version/config, Maven/SBT and other supported build-tool markers |

Inventory support may mean content parsing, cross-file context, or presence-only evidence; it does not mean every
file format has a full parser or dedicated rule. Generated dependency/build directories are excluded. Explicit
`ignorePaths` further defines scope. Symlinks and submodules are not followed.

Absence-based findings require a complete inventory of relevant repository files. File-count/size limits, API path
filters/truncated trees, unreadable files, opaque entries and explicitly excluded relevant files disable that inference.
Excluding an existing lock, version file, configuration or updater workflow does not establish that it is absent.
The engine also downgrades completeness when filtering files supplied directly through the API. Large ordinary
lockfiles can retain only their header; Nix/devenv locks require their full content. API callers supplying already-filtered
or partial `AnalysisInput` must not claim `inventoryComplete: true`.

The internal repository loader separately records completeness within a caller's selected scope. Run-knowledge
collection uses that narrower metadata only for its fixed declaration inventory and cache policy; explicit exclusions
do not make that selected scope incomplete or mark the filtered linter input globally complete. Unignored opaque
entries and collection limits still prevent complete knowledge reuse.

The built-in rules do not execute shell scripts, evaluate Nix, resolve arbitrary expressions, build containers or
run package managers. Unsupported/dynamic constructs are often left unanalyzed. A clean report is not proof of
correctness, complete coverage, hermeticity, or performance. Manual recommendations can change trust, dependencies,
coverage, lock policy and resource usage; validate those decisions in the target environment.

### Job dependency success gates

`workflow/artifact-success-gating` warns when a success-path job downloads a literal named artifact from a
unique producer in the same workflow, but has no direct or transitive `needs` path to that producer. It is
enabled in `recommended`, `agentic` and `strict`; it is advisory and has no autofix.

```powershell
npm run cli -- lint --rule workflow/artifact-success-gating=warn
npm run cli -- lint --explain workflow/artifact-success-gating
```

For example, a job downloading `dist` from a job uploading `dist` normally needs that producer. Review adding
the producer to its existing `needs` list, preserving other dependencies. The warning points at the download
and includes the upload as related evidence. Multiple downloads from the same producer produce one warning.
An upload can finish before a later step fails: artifact existence is not proof that its producer succeeded.
Validate the change across all triggers and failure/skip paths before adopting it.

**Conservative initial scope.** Only direct official `actions/upload-artifact` / `actions/download-artifact`
steps with exact literal names are linked; an omitted upload name means `artifact`. Downloads without a name,
pattern/ID downloads, cross-run/repository/token selectors, dynamic names, duplicate producers, producer matrices,
reusable/composite internals and conditional or failure-tolerant transfers are not inferred. A dynamic upload
suppresses this rule for that workflow because it could collide with a literal name. Jobs and transfers must
have no condition, `true`, or exactly `success()` (optionally expression-wrapped). Other conditions are left
unanalyzed. Failure-aware consumers, result-context users and required-check aggregation are excluded rather
than forced behind a success gate. Circular candidate edges are not recommended. This is not a general DAG
validator or an assertion that excluded workflows have correct failure propagation.

**Keep distinct failure policies distinct.** `needs` skips dependent jobs after failure (including dependency
chains); it does not cancel already-running independent jobs. An intermediate `always()` job alone is not
evidence that downstream default-success jobs bypass all ancestor failures. Explicit consumer `always()`,
`failure()` and `!cancelled()` conditions may intentionally collect diagnostics, clean up, notify, or aggregate
required checks. Their correctness requires understanding the result policy and scripts, so this rule does
not diagnose or rewrite them. Required-check aggregates must still inspect required outcomes and fail correctly;
do not make them skip failures in pursuit of fewer minutes. Independent lint/tests keep their useful parallelism:
names alone never establish an edge.

`triggers/shard-fail-fast` separately reviews an explicit `fail-fast: false` on a recognized sharded PR test
matrix; matrix cancellation is not inter-job gating. `workflow/concurrency` concerns superseded workflow runs,
not prerequisite failure. `testing/masked-failures` separately handles recognized silenced tests. These policies
are not interchangeable.

This detector supplies static configuration evidence, not telemetry-derived cost or savings. Existing run
telemetry retains its dependency attribution and overlapping savings-bound semantics. Observed failed-run
runner time is exposure, not proven removable cost; never sum overlapping bounds or describe bounds as measured
improvements. No other CI platform is covered by this rule. A clean report does not prove complete gating.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | No finding at or above `--fail-on`, and no more than `--max-warnings` warnings |
| `1` | Findings at or above `--fail-on` (default `error`), or more than `--max-warnings` warnings |
| `2` | Usage or configuration error: unknown flag, invalid configuration, unknown rule id, existing file for `--init` |

The threshold is applied to the final report, after `--quiet`, `--scope`, and path filtering.

### Explaining rules

```console
$ cicd-lint --explain workflow/job-timeout
workflow/job-timeout
  Ruleset:   workflow
  Kind:      practice
  Severity:  warn (default: warn)
  ...
```

The output has the rule's ruleset, kind, effective and default severity, presets, whether it is fixable, and its
impact. It also has the description, rationale, a before and after example when the rule has one, references, and the
docs link. Unknown
ids exit 2 with a "did you mean" suggestion.

## Output formats and editors

| Format | Use |
|---|---|
| `stylish` | Terminal output grouped by file, with a `Rule docs:` footer linking each reported rule |
| `json` | The full `LintResult` object, for scripts and editor plugins |
| `sarif` | SARIF 2.1.0 for GitHub code scanning and SARIF viewers |
| `github` | Workflow commands (`::error file=...`) that annotate pull requests |
| `markdown` | A table for pull request comments or job summaries |

The `json` result contains `diagnostics` (each with `ruleId`, `severity`, `path`, `line`, `column`, `message`,
`suggestion`, `docsUrl`, and `fix`), `parseProblems`, `skipped`, and, when requested, `unusedDirectives`.

There is no language server. For editor feedback, run the linter on save with `--stdin --stdin-filename <path> -f
json`, which lints the unsaved buffer in its repository context. Or open a `--sarif` report in a SARIF viewer, such as
the Microsoft SARIF Viewer extension for VS Code.

## Configuration

`cicd-lint --init` writes a commented starter `.github/ci-cd-optimizer.yml`. It refuses to overwrite an existing
file and exits 2. `cicd-lint --print-config` prints the effective configuration after `--preset`, `--rule`, and
`--ruleset` overrides:

```json
{
  "configPath": ".github/ci-cd-optimizer.yml",
  "config": { "schemaVersion": 1, "extends": ["recommended"], "failOn": "error", "...": "..." },
  "rules": { "workflow/job-timeout": "warn", "caching/setup-cache": "warn", "...": "..." }
}
```

Presets (`recommended`, `strict`, `agentic`, `github`, `insights`, `all`), rulesets, per-rule options, and
`ignorePaths` are described in [configuration.md](configuration.md). Shareable configurations from files or URLs are
not supported yet; presets are built in.

## Suppressions

Suppress findings with comments in any file that has `#` comments: workflows, composite actions, Dockerfiles,
`pnpm-lock.yaml`, and `yarn.lock`.

```yaml
jobs:
  # cicd-optimizer-disable-next-line workflow/job-timeout -- release is bounded by the environment's wait timer
  release:
    runs-on: ubuntu-24.04
```

```dockerfile
# cicd-optimizer-disable-file hermeticity, containers/multi-stage
FROM node:22
```

- `cicd-optimizer-disable-next-line` applies to the next line that is not blank and not a comment.
- `cicd-optimizer-disable-file` applies to the whole file, wherever it appears.
- After the directive, list rule ids or rulesets, separated by commas or spaces. With no list, every rule is
  suppressed.
- Text after ` -- ` is a reason and is ignored. Write one anyway.
- A directive must be on its own comment line. Comment-like lines inside YAML block scalars, such as `run: |`
  scripts, are not directives.
- JSON files cannot hold comments. Use `rules`, `rulesets`, or `ignorePaths` in the configuration instead.

Suppressed findings are counted in the result's `suppressed` total. They are not reported and do not affect the exit
code.

### Unused directives

`--report-unused-disable-directives` reports directives, and ids within them, that suppressed nothing. Stale
directives would otherwise hide the next regression on that line. These reports use the rule id
`cicd-optimizer/unused-disable-directive` at `warn`, or at `error` with `--report-unused-disable-directives=error`.
They count toward `--fail-on` and `--max-warnings`, appear in every format including SARIF, and cannot themselves be
suppressed. Unknown ids get a "did you mean" hint.

Reporting is conservative, to avoid false positives:

- Nothing is reported when the inventory was truncated or the configuration is disabled.
- Nothing is reported for a file that failed to parse.
- An id is not reported when its rule, or a rule in its ruleset, was skipped or crashed.
- A blanket directive (no ids) is not reported when any rule was skipped.

Ids naming rules that the configuration turned off *are* reported, because the directive no longer does anything.

## Custom local rules

A repository can add its own rules in JavaScript. They use the same API as built-in rules (`RuleModule`, `RuleMeta`,
`RuleContext`, and `ReportDescriptor` in [`src/lint/types.ts`](../src/lint/types.ts)):

```yaml
# .github/ci-cd-optimizer.yml
localRules:
  - .github/cicd-rules/approved-runners.mjs
rules:
  local/approved-runners: [error, { allowed: [ubuntu-24.04, ubuntu-24.04-arm] }]
```

```js
// .github/cicd-rules/approved-runners.mjs
// @ts-check

/**
 * Types are optional. With the package installed (or a clone's dist/ on hand), JSDoc gives editor checking.
 * @typedef {{ allowed: string[] }} Options
 * @type {import("ci-cd-optimizer/dist/lint/types.js").RuleModule<Options>}
 */
const approvedRunners = {
  meta: {
    id: "local/approved-runners",
    ruleset: "local",
    description: "Jobs run on the organization's approved runner labels.",
    rationale: "Other runners are slower to provision and are not covered by the shared cache warmers.",
    kind: "policy",
    defaultSeverity: "warn",
    presets: [],
    requires: [],
    defaultOptions: { allowed: ["ubuntu-24.04"] },
    references: [],
    impact: "medium",
    docsUrl: "https://example.com/ci/runners#approved-labels",
  },
  check({ options, project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const label = job.runsOn?.value;
        if (typeof label !== "string" || label.includes("${{") || options.allowed.includes(label)) continue;
        report({
          path: workflow.path,
          line: job.runsOn?.line ?? job.line,
          message: `Job "${job.id}" runs on "${label}", which is not an approved runner.`,
          suggestion: `Use one of: ${options.allowed.join(", ")}.`,
          key: `jobs.${job.id}.runs-on`,
        });
      }
    }
  },
};

export const rules = [approvedRunners];
```

```sh
cicd-lint --allow-local-rules
cicd-lint --allow-local-rules --explain local/approved-runners
```

What a module must look like:

- **Exports.** Export `rules` (an array), or a default export that is either a rule or an array of rules. `.mjs`
  files are ES modules. A `.js` file follows the nearest `package.json` `type`.
- **Required metadata.** `meta.id` matches `local/<name>` (lowercase letters, digits, hyphens).
- **Fixed values.** `meta.ruleset` is `"local"`. `meta.defaultSeverity` is `info`, `warn`, or `error`. `meta.kind`
  is `practice`, `policy`, or `insight`.
- **Lists and functions.** `meta.presets` and `meta.requires` are arrays. `meta.description` is a string. `check` is
  a function.
- **Optional fields.** `rationale`, `references`, `impact`, and `defaultOptions` default to `""`, `[]`, `"medium"`,
  and `{}`.
- **Docs links.** `meta.docsUrl` replaces the default docs link in reports.
- **Unique ids.** Ids must be unique across local modules and built-in rules.
- **Enabling rules.** A local rule runs only when a preset in `extends` lists it in `meta.presets`, or when `rules`
  or `rulesets` (`local: warn`) enable it.
- **Validation.** Configuration is validated against built-in and local rules together, so typos still get "did you
  mean" hints.

What the rule's `check` receives:

- **`project`**: parsed models (`workflows`, `actions`, `dockerfiles`, `manifests`, `facts`) and the raw `files` map.
- **`input`**: the analysis input, including the change set under `--base`.
- **`report`**: takes a `path`, a 1-based `line`, and a `message`. Optional fields are `suggestion`, `impact`,
  `confidence`, a stable `key` for fingerprints, and a safe `fix` with text edits.

`--list-rules`, `--explain`, `--print-config`, every output format, `--base`, and suppressions all include local
rules.

### Security

A local rule is arbitrary code from the repository, run with your permissions. Load local rules only from repositories
you trust:

- Local rules load only with the `--allow-local-rules` command-line flag. The configuration file cannot enable them,
  and the flag is off by default everywhere, including the GitHub Action and the reusable workflow. A configuration
  that lists `localRules` without the flag exits 2.
- Never pass the flag in workflows that run untrusted code, such as `pull_request_target` or pull requests from forks.
  A pull request could change the rule module and run code with the workflow's token.
- Paths must be repository-relative `.js` or `.mjs` files that exist. URLs, absolute paths, `..` escapes, and symbolic
  links that resolve outside the repository are rejected. These checks catch misconfiguration. They are not a
  sandbox.
- The GitHub App never loads local rules. It skips `local/*` settings in the configuration it reads.

## CI

### GitHub Action

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    persist-credentials: false
- uses: MSFT-TKENDRICK/ci-cd-optimizer@<full commit SHA>
  with:
    command: lint
    args: --format github --fail-on error --report-unused-disable-directives
```

The action's `exit-code` output carries the [exit code](#exit-codes). See [examples/workflows](../examples/workflows/) for `--base`,
SARIF, and scans.

### Reusable workflow

[`lint-reusable.yml`](../.github/workflows/lint-reusable.yml) checks out the caller and the tool side by side. It runs
the linter and uploads the SARIF report as the `cicd-optimizer-sarif` artifact.

```yaml
jobs:
  cicd-lint:
    uses: MSFT-TKENDRICK/ci-cd-optimizer/.github/workflows/lint-reusable.yml@<full commit SHA>
    permissions:
      contents: read
    with:
      tool-ref: <the same full commit SHA>
      args: --format github --fail-on warn
```

| Input | Default | Description |
|---|---|---|
| `args` | `--format github --fail-on error` | Extra arguments, split on whitespace (quotes group words). Never evaluated by a shell. |
| `upload-sarif` | `true` | Upload `cicd-optimizer.sarif` as the `cicd-optimizer-sarif` artifact |
| `working-directory` | `.` | Directory to lint, relative to the caller's repository root |
| `tool-ref` | `main` | Ref of this repository to run |

Pin both the `uses:` ref and `tool-ref` to the same full commit SHA. The `main` default follows the branch and is not
reproducible. The workflow asks only for `contents: read`. The `exit-code` output carries the linter's exit code.

### Code scanning

The reusable workflow does not ask for `security-events: write`. To show findings under **Security › Code scanning**,
add a job that forwards the artifact. Code scanning must be enabled for the repository: a repository admin enables it
under **Settings › Code security**.

```yaml
  cicd-lint-upload:
    needs: cicd-lint
    if: ${{ !cancelled() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: cicd-optimizer-sarif
          path: sarif
      - uses: github/codeql-action/upload-sarif@9418214df1f2c4b8128c770156c409013b07d6b9 # v3.39.3
        with:
          sarif_file: sarif/cicd-optimizer.sarif
          category: cicd-optimizer
```

SARIF paths are relative to the lint root. Lint from the repository root (`working-directory: .`) so code scanning
places alerts on the right files.

## Git hooks

### pre-commit

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/MSFT-TKENDRICK/ci-cd-optimizer
    rev: <full commit SHA>
    hooks:
      - id: cicd-lint
        # args: [--fail-on, warn]
```

The `cicd-lint` hook in [`.pre-commit-hooks.yaml`](../.pre-commit-hooks.yaml) works as follows:

- It runs when a staged file is a workflow, `action.yml`, a Dockerfile or Containerfile, `package.json`,
  `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`.
- It lints the whole repository, not just the staged files (`pass_filenames: false`), because rules compare files.
- It needs Node.js 22 or later on `PATH`. It is a `language: script` hook that runs the committed, self-contained
  Action bundle (`dist-action/index.js`) through [`scripts/cicd-lint-hook.mjs`](../scripts/cicd-lint-hook.mjs), so
  there is no `npm install` or build step. A `language: node` hook would not work: pre-commit installs those with
  `npm install -g git+file://…`, which runs only the `prepare` script, so `dist/` would never be built.
- Pass extra flags with `args`. The hook already runs `lint`, so `args: [--fail-on, warn]` works the same as
  `cicd-lint --fail-on warn`.

### lefthook

```yaml
# lefthook.yml
pre-commit:
  commands:
    cicd-lint:
      glob: "{.github/workflows/*.{yml,yaml},**/action.{yml,yaml},**/Dockerfile*,**/package.json,**/*.lock,**/*-lock.{json,yaml}}"
      run: npx --no-install cicd-lint
```

### husky

```sh
# .husky/pre-commit
npx --no-install cicd-lint
```

Both assume `cicd-lint` is installed in the project, for example from an `npm pack` tarball, or linked with
`npm link`.

## Comparison and credit

This linter checks speed and reproducibility: caching, affected-only builds, timeouts, pinning, and image layering.
It complements tools that check correctness and security. Run them side by side.

| Tool | Focus | What this linter borrows |
|---|---|---|
| [actionlint](https://github.com/rhysd/actionlint) | Workflow syntax, expression types, ShellCheck on `run:` | Workflow-first CLI, `--stdin-filename` |
| [zizmor](https://github.com/zizmorcore/zizmor) | Actions security: injection, permissions, unpinned actions | SARIF to code scanning, pre-commit hook, inline ignores |
| [hadolint](https://github.com/hadolint/hadolint) | Dockerfile best practices, ShellCheck on `RUN` | Comment directives in Dockerfiles, a failure threshold (`--fail-on`) |
| [ESLint](https://eslint.org/) | JavaScript, with a plugin ecosystem | Presets, `disable-next-line` and `-- reason` comments, `--report-unused-disable-directives`, `--print-config`, `--init`, exit codes 0, 1, and 2 |
| [super-linter](https://github.com/super-linter/super-linter), [MegaLinter](https://megalinter.io/) | Containers that run dozens of linters | Nothing directly; `cicd-lint` can run beside them as one more step |
| [Trunk Check](https://docs.trunk.io/check) | Meta-linter with pinned linter versions | "Hold the line": `--base` reports only introduced findings |

Not supported yet:

- **Shareable configurations from files or URLs.** These carry supply-chain risk. A repository-local
  `extends: ./path.yml` is the likely next step.
- **Declarative YAML rules.** Rules are written in JavaScript instead.
- **Colored output.**
- **A dedicated problem matcher.** Use `-f github` instead.
