# Rule catalog

| Rule | Category | What it detects |
|---|---|---|
| `workflow-concurrency` | Workflow | Obsolete runs are not canceled |
| `workflow-timeout` | Workflow | Jobs have no explicit timeout |
| `dependency-cache` | Caching | Dependencies are installed without caching |
| `immutable-dependency-install` | Hermeticity | Installs may ignore lockfile immutability |
| `artifact-retention` | Workflow | Transient artifacts use default retention |
| `path-filtering` | Monorepo | Multi-project repositories run without path filtering |
| `docker-build-cache` | Caching | BuildKit cache is not persisted |
| `docker-dependency-layer` | Containers | Source invalidates the dependency layer |
| `docker-multistage` | Containers | Build tooling remains in the runtime image |
| `ghcr-output` | Registries | Images are pushed without detected GHCR usage |
| `github-npm-registry` | Registries | Internal npm publication lacks GitHub Packages configuration |

The first release deliberately favors high-signal static checks. More advanced
recommendations—test sharding, runner sizing, remote execution, build graph
optimization, and cache effectiveness—need workflow telemetry to avoid generic
or misleading advice.
