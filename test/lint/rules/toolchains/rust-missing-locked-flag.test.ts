import rule from "../../../../src/lint/rules/toolchains/rust-missing-locked-flag.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const CRATE = { "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n', "Cargo.lock": "version = 4\n" };

ruleTester(rule, {
  valid: [
    {
      name: "--locked after the subcommand",
      files: { [WORKFLOW]: job("      - run: cargo test --locked --all-features"), ...CRATE },
    },
    {
      name: "global --locked before the subcommand and --frozen",
      files: { [WORKFLOW]: job("      - run: cargo --locked build", "      - run: cargo build --frozen --release"), ...CRATE },
    },
    {
      name: "trap: later commands reuse the lockfile verified by the first one",
      files: { [WORKFLOW]: job("      - run: cargo fetch --locked", "      - run: cargo test", "      - run: cargo clippy"), ...CRATE },
    },
    {
      name: "trap: no committed Cargo.lock (library crate)",
      files: { [WORKFLOW]: job("      - run: cargo test"), "Cargo.toml": '[package]\nname = "demo"\n' },
    },
    {
      name: "trap: dependency-update job changes the lockfile on purpose",
      files: { [WORKFLOW]: job("      - run: cargo update", "      - run: cargo test"), ...CRATE },
    },
    {
      name: "trap: cargo install of a tool is a different concern",
      files: { [WORKFLOW]: job("      - run: cargo install cargo-nextest"), ...CRATE },
    },
    {
      name: "trap: flags supplied through a variable cannot be checked",
      files: { [WORKFLOW]: job("      - run: cargo build $CARGO_FLAGS"), ...CRATE },
    },
  ],
  invalid: [
    {
      name: "cargo test without --locked",
      files: { [WORKFLOW]: job("      - run: cargo test --all-features"), ...CRATE },
      errors: [{ line: 7, path: WORKFLOW, messageIncludes: "`cargo test --all-features` runs without `--locked` although `Cargo.lock` is committed" }],
      output: { [WORKFLOW]: job("      - run: cargo test --locked --all-features") },
    },
    {
      name: "trap: --locked after `--` is passed to clippy-driver, not Cargo",
      files: { [WORKFLOW]: job("      - run: cargo +nightly clippy -- --locked -D warnings"), ...CRATE },
      errors: [{ line: 7, messageIncludes: "`cargo +nightly clippy -- --locked -D warnings` runs without `--locked`" }],
      output: { [WORKFLOW]: job("      - run: cargo +nightly clippy --locked -- --locked -D warnings") },
    },
    {
      name: "workspace member uses the workspace root lockfile",
      files: {
        [WORKFLOW]: job("      - run: cargo build --release", "        working-directory: crates/cli"),
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
        "Cargo.lock": "version = 4\n",
        "crates/cli/Cargo.toml": '[package]\nname = "cli"\n',
      },
      errors: [{ line: 7, messageIncludes: "although `Cargo.lock` is committed" }],
      output: { [WORKFLOW]: job("      - run: cargo build --locked --release", "        working-directory: crates/cli") },
    },
    {
      name: "multi-line run block, only the first cargo command is reported",
      files: { [WORKFLOW]: job("      - run: |", "          cargo build", "          cargo test"), ...CRATE },
      errors: [{ line: 8, messageIncludes: "`cargo build` runs without `--locked`" }],
      output: { [WORKFLOW]: job("      - run: |", "          cargo build --locked", "          cargo test") },
    },
  ],
});
