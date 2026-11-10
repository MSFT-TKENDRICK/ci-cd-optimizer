/** Files whose presence or content rules depend on. Everything else is outside the built-in inventory. */
const BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc.yml",
  ".npmignore",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "tsconfig.json",
  "nx.json",
  "turbo.json",
  "lerna.json",
  "rush.json",
  "MODULE.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  "pants.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "pom.xml",
  "build.sbt",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "uv.lock",
  "packages.lock.json",
  "Directory.Packages.props",
  "global.json",
  "docker-bake.hcl",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".dockerignore",
  "action.yml",
  "action.yaml",
  "flake.lock",
  ".envrc",
  "devenv.yaml",
  "devenv.lock",
  "CMakeLists.txt",
  "meson.build",
  ".python-version",
  ".go-version",
  ".java-version",
  ".sdkmanrc",
  "rust-toolchain",
  "rust-toolchain.toml",
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
]);

/** These ordinary lockfiles need only their presence/header; Nix lock contents remain mandatory. */
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "packages.lock.json"]);
export const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "__pycache__", ".turbo", ".nx", "target", ".gradle", ".direnv"]);

export function isInventoryPath(path: string): boolean {
  if (path.split("/").slice(0, -1).some((part) => SKIP_DIRS.has(part))) return false;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return true;
  if (/^\.github\/ci-cd-optimizer\.ya?ml$/.test(path)) return true;
  if (/^\.github\/(dependabot\.ya?ml|renovate\.json5?)$/.test(path)) return true;
  if (/(^|\/)\.cargo\/config(\.toml)?$/.test(path) || /(^|\/)gradle\/wrapper\/gradle-wrapper\.properties$/.test(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (BASENAMES.has(name)) return true;
  if (/^(Dockerfile|Containerfile)(\.[^/]+)?$/i.test(name) || /\.(dockerfile|containerfile|dockerignore)$/i.test(name)) return true;
  if (/^requirements.*\.txt$/i.test(name) || /(^|\/)requirements\/[^/]+\.txt$/i.test(path)) return true;
  if (/\.bazelrc$/i.test(name) || /\.(csproj|fsproj|sln)$/i.test(name)) return true;
  if (/\.nix$/i.test(name)) return true;
  return path === ".changeset/config.json";
}

export const isLockfile = (path: string) => LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));
