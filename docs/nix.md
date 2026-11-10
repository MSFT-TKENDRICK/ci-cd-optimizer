# Nix analysis

The `nix` ruleset contains 37 advisory rules. It is built into the same engine used by the CLI, GitHub Action,
reusable workflow, GitHub App and API scans. Nix is not required on the machine running the linter: analysis never
evaluates expressions, invokes installers, contacts binary caches, updates a lock or builds a derivation.

Use the [generated rule catalog](rules.md) for each rule's severity, presets, options, examples and references.

## Run and configure

```sh
cicd-lint --preset recommended
cicd-lint --ruleset nix=warn
cicd-lint flake.nix .github/workflows
cicd-lint --explain nix/duplicate-nixpkgs-nodes
```

Path arguments filter the report, not the repository context loaded for analysis. Configuration is shared across
entry points:

```yaml
schemaVersion: 1
extends: [recommended, agentic]
rules:
  nix/get-env-builtin: [info, { allow: [APP_VERSION] }]
  nix/max-jobs-pinned-low: info
  nix/duplicate-nixpkgs-nodes: warn
```

`recommended`, `agentic` and `strict` select different subsets. `all` selects every built-in rule, not just Nix.
To select only Nix, use `extends: []` with `rulesets: { nix: warn }`, then override individual rules as needed.
None of the 37 Nix rules offers an automatic edit.

## Coverage

### CI and configuration — 16 rules

| Rules | Visible evidence |
|---|---|
| `accept-flake-config-untrusted`, `quick-install-implicit-flake-config-trust` | Requests to accept flake configuration in untrusted contexts, including modeled installer defaults |
| `channel-in-ci`, `nix-shell-dash-p-unpinned`, `installer-unpinned-nix-version` | Channel/package selection and installer version declarations |
| `impure-flag-in-ci`, `sandbox-disabled`, `nix-build-inside-docker` | Explicit impurity/sandbox requests and containerized Nix builds; not proof of the daemon or builder's actual isolation |
| `no-binary-cache-configured`, `raw-store-cache`, `outdated-magic-nix-cache` | Visible cache configuration, raw store archives and known action-version behavior |
| `flake-check-missing-parallel-evaluator`, `max-jobs-pinned-low` | Evaluation/build concurrency settings; recommendations require workload/resource measurements |
| `dev-shell-reinvoked-per-step`, `separate-nix-build-invocations`, `imperative-install` | Repeated shell/build entry points and imperative installation |

### Expression structure — 12 rules

| Rules | Visible evidence |
|---|---|
| `current-system-builtin`, `get-env-builtin`, `nixpkgs-angle-bracket-path` | Evaluator/system/environment/search-path dependencies |
| `builtins-fetchurl-unverified`, `fetchgit-missing-rev`, `fetchtarball-no-hash`, `fake-hash-committed` | Recognizable builtin fetcher constraints and placeholder hashes |
| `import-from-derivation` | Recognizable evaluation-time consumption of derivation output |
| `src-whole-repo`, `overlay-overrides-foundational-package` | Source selection and foundational package overrides |
| `rust-two-phase-build`, `dockertools-single-layer-image` | Opportunities to separate dependency work or image layers, subject to semantic and performance checks |

### Flakes and locks — 9 rules

| Rules | Visible evidence |
|---|---|
| `missing-flake-lock`, `flake-lock-missing-input` | Missing lock/input evidence when the relevant inventory and syntax are known |
| `duplicate-nixpkgs-nodes` | Multiple distinct locked nixpkgs nodes, not proof they are redundant or interchangeable |
| `git-input-for-github`, `indirect-input`, `nixpkgs-input-not-channel` | Input URL/type and branch-selection declarations |
| `flake-nixconfig-cache-not-trusted` | Declared flake cache settings without recognizable acceptance at a consumer |
| `flake-update-in-build-job`, `no-lock-update-automation` | Recognizable lock updates and automation, with maintenance/conditional boundaries |

Every identifier above has the `nix/` prefix. Registering a flake input does not establish the availability,
trustworthiness or reproducibility of its source or outputs.

## Inputs and inventory boundaries

The directory, Git-tree and GitHub API loaders recognize `*.nix` case-insensitively, `flake.lock`, `.envrc`,
`devenv.yaml`, `devenv.lock`, workflows and composite actions, plus related package/toolchain configuration.
Files are analyzed statically and in their repository-relative context. Recognized Nixpkgs source trees require
multiple structural markers before package-expression checks are excluded; one similarly named user file does
not exclude a normal project.

Rules that infer absence require a complete inventory of relevant repository files. Limits, unreadable entries,
API filtering/truncation, links/submodules and exclusions of existing relevant files can make it incomplete.
Symlinks/submodules are not followed. Oversized Nix/devenv locks are not treated as complete merely because their
names were listed. Ignoring a lock, configuration or updater workflow cannot turn it into evidence of absence.
Complete-inventory rules are conservatively skipped after such exclusions; an expected flake lock whose exact path
matches an ignore pattern is also never reported missing.

Providing a few files to the engine is not equivalent to loading a complete repository. An API caller must only
set `inventoryComplete: true` when that claim is warranted. `ENGINE_API_VERSION = 1` remains the API compatibility
marker, not an assurance level.

## Static model and necessary assumptions

- **Nix structure:** a lossless lexical scanner recognizes strings, comments, identifiers, balanced structures,
  selected bindings and lock graphs. It is not the Nix evaluator, full grammar/type checker or a complete name
  resolver. Recognizable rebinding suppresses builtin assumptions. Dynamic attributes, arbitrary functions and
  unresolved inputs can prevent a finding. Builtin-specific messages assume the identified builtin's documented
  behavior; unused lazy expressions need not execute. Delimiter/enclosing-scope indexes and builder/binding facts
  are reused per parsed file; they describe the masked source, not evaluated Nix semantics.
- **Shell commands:** recognizable invocations, quoting, wrappers and literal arguments are inspected without
  interpreting the shell. Definitions, substitutions and opaque environment changes can leave behavior unknown.
  Quoted examples, help/version queries and arguments belonging to another command are not build executions.
  External scripts and arbitrary user functions are not followed.
- **Configuration:** inference is local to the workflow/job/step and consumer command. Recognized preceding file
  writes, environment values and CLI options are considered in their modeled precedence; later steps do not
  affect earlier commands. Custom configuration search paths, includes, conditional/opaque writes, multiple
  installers and environment-resetting wrappers can make a setting unknown.
- **Nested commands:** a `nix develop`/dev-shell child is not assumed to inherit the outer effective configuration.
  An explicit nested CLI request can still be reported as a request. Runner OS, daemon trust policy, Nix version,
  remote builders and external configuration can change or reject the requested runtime behavior.
- **Actions and versions:** version-specific assumptions use bounded known releases, not guesses about future
  majors, moving refs or unannotated commit SHAs. For modeled quick-install releases that append
  `accept-flake-config = true`, installer input ordering matters: an earlier false value in the input is not
  necessarily effective. Recognized environment/CLI overrides are considered separately.
- **Cache behavior:** a declared cache or matching modeled key is not proof of a hit, authorization, compatible
  artifact, upload, download, or avoided build. Branch scopes, actual cache versions, trust and other cache sources
  still matter. A sandbox flag likewise does not establish enforced isolation.

Unknown behavior intentionally favors missed suggestions over confident reports about an unmodeled execution.
Neither all supported syntax nor all possible problems are claimed to be covered.

## Review recommendations before changing policy

These are manual decisions, not semantics-preserving rewrites:

- Adding `follows` for duplicate nixpkgs nodes changes dependency selection. Review constraints, regenerate and
  inspect the lock, and evaluate/build/test the intended outputs.
- Changing Git inputs to archive-style inputs can affect submodules, LFS, authentication and fetcher metadata.
- Enabling/disabling flake-config trust changes a security boundary and cache behavior. Keep untrusted workflows
  isolated; do not treat a cache-speed recommendation as permission to trust arbitrary configuration.
- Changing sandboxing, impurity, CPU/job limits or source filters can alter successful builds, resource pressure
  and required inputs. Establish the intended behavior first.
- Replacing repeated invocations or reorganizing derivations/layers can affect hooks, outputs and cache reuse.
  Validate the result and measure both cold and warm runs.
- A newly fetched checksum authenticates bytes only relative to the expected digest or signing key. Obtain that
  expectation through an independently trusted channel, rather than blindly blessing the current download.

## What the evidence does not prove

The detectors and their recommendations are not universal formal proofs of correctness, hermeticity or improved
performance. Regression tests, corpus examples, typechecking, linting and self-lint establish concrete checks,
not universal quantification over Nix, shell, GitHub Actions or runtime environments. Diagnostic confidence,
severity and impact are heuristic assessments. A clean report is not proof of safety or complete coverage.

Treat a recommendation as a reviewable hypothesis with explicit context. Test semantic changes against the
project's required outputs and use workload-specific measurements for performance conclusions.
