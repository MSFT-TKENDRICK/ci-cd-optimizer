import { describe, expect, it } from "vitest";
import { shellWords } from "../../../../src/lint/parsers/shell.js";
import type { AnyRule } from "../../../../src/lint/types.js";
import go from "../../../../src/lint/rules/toolchains/go-mod-mutable-override.js";
import gradle from "../../../../src/lint/rules/toolchains/gradle-build-cache-disabled.js";
import incremental from "../../../../src/lint/rules/toolchains/rust-cargo-incremental-in-ci.js";
import locked from "../../../../src/lint/rules/toolchains/rust-missing-locked-flag.js";
import rust from "../../../../src/lint/rules/toolchains/rust-toolchain-unpinned.js";
import pip from "../../../../src/lint/rules/toolchains/python-pip-no-hash-check.js";
import uv from "../../../../src/lint/rules/toolchains/uv-sync-unlocked.js";
import { githubEnvPairs, withInserted } from "../../../../src/lint/rules/toolchains/shared.js";
import { runRule } from "../../rule-tester.js";

const WORKFLOW = ".github/workflows/ci.yml";
const job = (...steps: string[]): string => [
  "on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps, "",
].join("\n");
const CRATE = { "Cargo.toml": '[package]\nname = "demo"\nversion = "1.0.0"\n', "Cargo.lock": "version = 4\n" };
const PYTHON = { "pyproject.toml": '[project]\nname = "demo"\nversion = "1.0.0"\n', "uv.lock": "version = 1\n" };
const GRADLE = { "settings.gradle": 'rootProject.name = "demo"\n', "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n" };
const GO = { "go.mod": "module example.com/demo\n\ngo 1.24\n" };
const cache = (path = "target", action = "actions/cache@v4"): string[] => [
  `      - uses: ${action}`, "        with:", `          path: ${path}`, "          key: cargo",
];
const count = (rule: AnyRule, files: Record<string, string>, expected: number): void => {
  const diagnostics = runRule(rule, { files });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toHaveLength(expected);
  expect(diagnostics.every((diagnostic) => diagnostic.fix === undefined)).toBe(true);
};

describe("Rust selections belong to a consumer and its preceding setup", () => {
  it.each([
    ["later installation does not select an earlier command", ["      - run: cargo test", "      - uses: dtolnay/rust-toolchain@stable"], 0],
    ["a later pin does not protect an earlier build", ["      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test", "      - uses: dtolnay/rust-toolchain@1.89.0"], 1],
    ["the last preceding default wins", ["      - uses: dtolnay/rust-toolchain@stable", "      - uses: dtolnay/rust-toolchain@1.89.0", "      - run: cargo test"], 0],
    ["one explicit command toolchain does not pin the next", ["      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo +1.89.0 test", "      - run: cargo test"], 1],
    ["one step environment does not pin another", ["      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test", "        env:", "          RUSTUP_TOOLCHAIN: 1.89.0", "      - run: cargo test"], 1],
    ["install-only rustup command does not select a default", ["      - run: rustup toolchain install stable", "      - run: cargo test"], 0],
    ["installing a pin does not change a floating default", ["      - run: rustup default stable", "      - run: rustup toolchain install 1.89.0", "      - run: cargo test"], 1],
    ["directory override outranks a later default", ["      - run: rustup override set 1.89.0", "      - run: rustup default stable", "      - run: cargo test"], 0],
    ["floating directory override outranks a pinned default", ["      - run: rustup override set stable", "      - run: rustup default 1.89.0", "      - run: cargo test"], 1],
    ["removed overrides are not assumed effective", ["      - run: rustup override set stable", "      - run: rustup default 1.89.0", "      - run: rustup override unset", "      - run: cargo test"], 0],
    ["disabled setup override only installs", ["      - uses: actions-rust-lang/setup-rust-toolchain@v1", "        with:", "          toolchain: stable", "          override: false", "      - run: cargo test"], 0],
    ["a later cache does not make earlier nightly use a cache consumer", ["      - uses: dtolnay/rust-toolchain@nightly", "      - run: cargo test", "      - uses: Swatinem/rust-cache@v2"], 0],
    ["conditional replacement has unknown selection", ["      - uses: dtolnay/rust-toolchain@stable", "      - uses: dtolnay/rust-toolchain@1.89.0", "        if: inputs.use_pin", "      - run: cargo test"], 0],
    ["dynamic command override is unknown", ["      - uses: dtolnay/rust-toolchain@stable", '      - run: cargo "$TOOLCHAIN" test'], 0],
    ["dynamic directory override can supersede an earlier selection", ["      - run: rustup override set stable", "      - uses: actions-rs/toolchain@v1", "        with:", "          toolchain: 1.89.0", "          override: ${{ inputs.override }}", "      - run: cargo test"], 0],
    ["queries do not compile with the floating selection", ["      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo --version", "      - run: cargo test --help"], 0],
  ] as const)("%s", (_name, steps, expected) => count(rust, { ...CRATE, [WORKFLOW]: job(...steps) }, expected));

  it("does not exempt unrelated jobs because another job pins Rust", () => {
    count(rust, {
      ...CRATE,
      [WORKFLOW]: [
        "on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:",
        "      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test",
        "  tooling:", "    runs-on: ubuntu-latest", "    steps:",
        "      - uses: dtolnay/rust-toolchain@1.89.0", "      - run: cargo fmt", "",
      ].join("\n"),
    }, 1);
  });

  it("does not transfer directory overrides to sibling crates", () => {
    count(rust, {
      ...CRATE, "sub/Cargo.toml": CRATE["Cargo.toml"],
      [WORKFLOW]: job("      - run: rustup default 1.89.0", "      - run: rustup override set stable", "        working-directory: sub", "      - run: cargo test"),
    }, 0);
  });

  it("replaces only the selected rustup argument in its manual example", () => {
    const diagnostics = runRule(rust, { files: {
      ...CRATE, [WORKFLOW]: job("      - run: LABEL=stable rustup default stable", "      - run: cargo test"),
    } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.suggestion).toContain("LABEL=stable rustup default 1.89.0");
    expect(diagnostics[0]?.suggestion).not.toContain("LABEL=1.89.0");
  });
});

describe("incremental compilation needs a relevant cache path", () => {
  it.each(["other/target", "target/release", "target/doc"])("does not infer overlap with %s", (path) => {
    count(incremental, { ...CRATE, [WORKFLOW]: job(...cache(path), "      - run: CARGO_INCREMENTAL=1 cargo test") }, 0);
  });

  it.each(["CARGO_HOME", "CARGO_TARGET_DIR", "CARGO_BUILD_BUILD_DIR", "RUSTFLAGS"])("checks %s before the forced-on branch", (name) => {
    count(incremental, {
      ...CRATE, [WORKFLOW]: job(...cache(), "      - run: cargo test", "        env:", "          CARGO_INCREMENTAL: 1", `          ${name}: elsewhere`),
    }, 0);
  });

  it.each(["target-dir", "build-dir"])("does not assume default paths with build.%s", (key) => {
    count(incremental, {
      ...CRATE, ".cargo/config.toml": `[build]\n${key} = "elsewhere"\n`,
      [WORKFLOW]: job(...cache(), "      - run: CARGO_INCREMENTAL=1 cargo test"),
    }, 0);
  });

  it.each(["--target-dir elsewhere", "--config 'build.target-dir=\"elsewhere\"'", "--help"])("leaves path overrides/queries alone: %s", (args) => {
    count(incremental, { ...CRATE, [WORKFLOW]: job(...cache(), `      - run: CARGO_INCREMENTAL=1 cargo test ${args}`) }, 0);
  });

  it.each(["cache-targets: false", "workspaces: sub", "cache-targets: ${{ inputs.cache_targets }}"])("respects rust-cache input %s", (input) => {
    count(incremental, {
      ...CRATE, [WORKFLOW]: job("      - uses: Swatinem/rust-cache@v2", "        with:", `          ${input}`, "      - run: CARGO_INCREMENTAL=1 cargo test"),
    }, 0);
  });

  it("does not use a later rust-cache step to describe earlier compilation", () => {
    count(incremental, { ...CRATE, [WORKFLOW]: job("      - run: CARGO_INCREMENTAL=1 cargo test", "      - uses: Swatinem/rust-cache@v2") }, 0);
  });

  it("does not infer an old Cargo default after rustup changes the selection", () => {
    count(incremental, {
      ...CRATE, [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@1.85.0", ...cache(), "      - run: rustup default 1.99.0", "      - run: cargo test"),
    }, 0);
  });

  it("describes restore-only cache policy without claiming an upload", () => {
    const diagnostics = runRule(incremental, {
      files: { ...CRATE, [WORKFLOW]: job(...cache("target", "actions/cache/restore@v4"), "      - run: CARGO_INCREMENTAL=1 cargo test") },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("do not establish an upload or reuse");
    expect(diagnostics[0]?.fix).toBeUndefined();
  });
});

describe("Gradle decisions remain per invocation", () => {
  it.each([
    ["a flag on a different invocation", ["      - run: ./gradlew build --build-cache", "      - run: ./gradlew test"], 1],
    ["printed configuration text", ['      - run: echo "org.gradle.caching=true >> gradle.properties"', "      - run: ./gradlew build"], 1],
    ["an unrelated environment variable", ["      - run: ./gradlew build", "        env:", "          NOTE: org.gradle.caching=true"], 1],
    ["a real properties write", ["      - run: echo 'org.gradle.caching=true' >> gradle.properties", "      - run: ./gradlew build"], 0],
    ["a relevant JVM property", ["      - run: ./gradlew build", "        env:", "          JAVA_TOOL_OPTIONS: -Dorg.gradle.caching=true"], 0],
  ] as const)("%s", (_name, steps, expected) => count(gradle, { ...GRADLE, [WORKFLOW]: job(...steps) }, expected));

  it("does not transfer an enabled cache between jobs sharing the same build", () => {
    count(gradle, {
      ...GRADLE, [WORKFLOW]: [
        "on: push", "jobs:", "  enabled:", "    runs-on: ubuntu-latest", "    env:",
        "      GRADLE_OPTS: -Dorg.gradle.caching=true", "    steps:", "      - run: ./gradlew build",
        "  other:", "    runs-on: ubuntu-latest", "    steps:", "      - run: ./gradlew test", "",
      ].join("\n"),
    }, 1);
  });
});

describe("lock enforcement is not transitive between commands", () => {
  it("reports Cargo after an earlier locked operation, but not help or option values", () => {
    count(locked, { ...CRATE, [WORKFLOW]: job("      - run: cargo fetch --locked", "      - run: cargo +1.89.0 test") }, 1);
    count(locked, { ...CRATE, [WORKFLOW]: job("      - run: cargo test --help") }, 0);
    count(locked, { ...CRATE, [WORKFLOW]: job('      - run: cargo +1.89.0 test --features "--locked"') }, 1);
  });

  it("reports uv run after an earlier locked sync", () => {
    count(uv, { ...PYTHON, [WORKFLOW]: job("      - run: uv sync --locked", "      - run: uv run pytest") }, 1);
  });

  it.each([
    ["0.4.24", "1", 1], ["0.4.25", "1", 0], ["0.4.25", "false", 1], ["0.4.25", "0", 1],
  ] as const)("checks uv %s and UV_LOCKED=%s", (version, value, expected) => {
    count(uv, { ...PYTHON, [WORKFLOW]: job(
      "      - uses: astral-sh/setup-uv@v6", "        with:", `          version: '${version}'`,
      "      - run: uv sync", "        env:", `          UV_LOCKED: '${value}'`,
    ) }, expected);
  });

  it.each(["false", "0", "off"])("does not mistake PIP_REQUIRE_HASHES=%s for enforcement", (value) => {
    count(pip, {
      "requirements.txt": "requests==2.32.3\n",
      [WORKFLOW]: job("      - run: pip install -r requirements.txt", "        env:", `          PIP_REQUIRE_HASHES: '${value}'`),
    }, 1);
  });
});

describe("Go flag and environment precedence", () => {
  it.each([
    ["-mod=mod -mod=readonly", 0], ["-mod=readonly -mod=mod", 1], ["-ldflags=-mod=mod", 0],
    ["-mod mod", 0], ["-mod=mod $LATER_FLAGS", 0],
  ] as const)("uses the final actual GOFLAGS mode in %s", (flags, expected) => {
    count(go, { ...GO, [WORKFLOW]: job("      - run: go test ./...", "        env:", `          GOFLAGS: ${JSON.stringify(flags)}`) }, expected);
  });

  it.each([
    ["a printed write", ['      - run: echo "go env -w GOFLAGS=-mod=mod"', "      - run: go test ./..."], 0],
    ["a later reset", ["      - run: go env -w GOFLAGS=-mod=mod", "      - run: go env -u GOFLAGS", "      - run: go test ./..."], 0],
    ["a later readonly write", ["      - run: go env -w GOFLAGS=-mod=mod", "      - run: go env -w GOFLAGS=-mod=readonly", "      - run: go test ./..."], 0],
    ["a real final mutable write", ["      - run: go env -w GOFLAGS=-mod=readonly", "      - run: go env -w GOFLAGS=-mod=mod", "      - run: go test ./..."], 1],
    ["GOENV off", ["      - run: go env -w GOFLAGS=-mod=mod", "      - run: go test ./...", "        env:", "          GOENV: 'off'"], 0],
    ["unknown working directory", ["      - run: go test -mod=mod ./...", "        working-directory: ${{ inputs.directory }}"], 0],
    ["program arguments after go run", ["      - run: go run ./cmd/app -mod=mod"], 0],
    ["test binary arguments", ["      - run: go test ./... -args -mod=mod"], 0],
    ["a changed home changes the go env file", ["      - run: go env -w GOFLAGS=-mod=mod", "      - run: go test ./...", "        env:", "          HOME: /different"], 0],
    ["a conditional go env write", ["      - run: |", "          if condition; then", "            go env -w GOFLAGS=-mod=mod", "          fi", "      - run: go test ./..."], 0],
  ] as const)("%s", (_name, steps, expected) => count(go, { ...GO, [WORKFLOW]: job(...steps) }, expected));

  it("does not rewrite a -mod=mod lookalike inside another flag's value", () => {
    const diagnostics = runRule(go, { files: {
      ...GO, [WORKFLOW]: job(`      - run: NOTE=-mod=mod go test -ldflags '-X main.mode=-mod=mod' -mod=mod ./...`),
    } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.suggestion).toContain(`NOTE=-mod=mod go test -ldflags '-X main.mode=-mod=mod' -mod=readonly ./...`);
  });
});

describe("manual suggestions and shell state", () => {
  it("inserts after the actual command prefix while preserving wrappers and quotes", () => {
    const raw = `LABEL="cargo test" env FOO=1 "cargo" "+1.89.0" "test" --features "one two"`;
    expect(withInserted(raw, shellWords(raw), ["cargo", "+1.89.0", "test"], " --locked"))
      .toBe(`LABEL="cargo test" env FOO=1 "cargo" "+1.89.0" "test" --locked --features "one two"`);
  });

  it("only parses actual GITHUB_ENV redirection, not quoted illustrations", () => {
    expect([...githubEnvPairs('echo "UV_LOCKED=1 >> $GITHUB_ENV"')]).toEqual([]);
    expect([...githubEnvPairs('echo "UV_LOCKED=1" >> "$GITHUB_ENV"')]).toEqual([["UV_LOCKED", "1"]]);
    expect([...githubEnvPairs("echo 'UV_LOCKED=1' >> '$GITHUB_ENV'")]).toEqual([]);
  });

  it("does not infer an absent lock policy after opaque environment writes or exports", () => {
    count(uv, { ...PYTHON, [WORKFLOW]: job('      - run: cat policy.env >> "$GITHUB_ENV"', "      - run: uv sync") }, 0);
    count(uv, { ...PYTHON, [WORKFLOW]: job("      - run: |", "          export UV_LOCKED=$(get-policy)", "          uv sync") }, 0);
  });

  it("does not execute or lint a function body as an invoked build", () => {
    count(locked, { ...CRATE, [WORKFLOW]: job("      - run: |", "          unused() {", "            cargo test", "          }", "          echo ready") }, 0);
  });
});
