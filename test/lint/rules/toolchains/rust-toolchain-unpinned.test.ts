import rule from "../../../../src/lint/rules/toolchains/rust-toolchain-unpinned.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const CRATE = { "Cargo.toml": '[package]\nname = "demo"\n' };

ruleTester(rule, {
  valid: [
    {
      name: "installer pinned to a release",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@1.89.0", "      - run: cargo test --locked"), ...CRATE },
    },
    {
      name: "rust-toolchain.toml pins the release",
      files: {
        [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test"),
        ...CRATE,
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.89.0"\n',
      },
    },
    {
      name: "trap: nightly job without a cache is deliberate",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@nightly", "      - run: cargo +nightly fmt --check"), ...CRATE },
    },
    {
      name: "trap: matrix-driven toolchain",
      files: {
        [WORKFLOW]: job(
          "      - uses: dtolnay/rust-toolchain@master",
          "        with:",
          "          toolchain: ${{ matrix.rust }}",
          "      - run: cargo test",
        ),
        ...CRATE,
      },
    },
    {
      name: "trap: MSRV job next to a latest-stable job",
      files: {
        [WORKFLOW]: yml(
          "on: push",
          "jobs:",
          "  stable:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: dtolnay/rust-toolchain@stable",
          "      - run: cargo test",
          "  msrv:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: dtolnay/rust-toolchain@1.70.0",
          "      - run: cargo check",
        ),
        ...CRATE,
      },
    },
    {
      name: "trap: cargo +toolchain overrides the default",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo +1.89.0 test"), ...CRATE },
    },
    {
      name: "trap: incomplete inventory cannot prove the toolchain file is absent",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test"), ...CRATE },
      inventoryComplete: false,
    },
    {
      name: "trap: no Cargo.toml",
      files: job("      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test"),
    },
  ],
  invalid: [
    {
      name: "dtolnay/rust-toolchain@stable without a cache",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test --locked"), ...CRATE },
      errors: [
        {
          line: 7,
          path: WORKFLOW,
          messageIncludes:
            "`uses: dtolnay/rust-toolchain@stable` installs the floating `stable` Rust toolchain and the repository has no `rust-toolchain.toml` pinning a release, so the compiler and its bundled Clippy and rustfmt change whenever a new release ships, and a commit that passed can fail",
        },
      ],
    },
    {
      name: "rustup default stable with rust-cache",
      files: {
        [WORKFLOW]: job("      - run: rustup default stable", "      - uses: Swatinem/rust-cache@v2", "      - run: cargo build"),
        ...CRATE,
      },
      errors: [
        {
          line: 7,
          messageIncludes: "`rustup default stable` installs the floating `stable` Rust toolchain",
        },
      ],
    },
    {
      name: "setup-rust-toolchain without a toolchain input",
      files: { [WORKFLOW]: job("      - uses: actions-rust-lang/setup-rust-toolchain@v1", "      - run: cargo clippy"), ...CRATE },
      errors: [
        {
          line: 7,
          messageIncludes:
            "`uses: actions-rust-lang/setup-rust-toolchain@v1` without a `toolchain` input installs the floating `stable` Rust toolchain and the repository has no `rust-toolchain.toml` pinning a release, so the compiler and its bundled Clippy and rustfmt change whenever a new release ships; `actions-rust-lang/setup-rust-toolchain (which runs Swatinem/rust-cache)` includes the rustc version in its cache key",
        },
      ],
    },
    {
      name: "nightly input with a rust-cache",
      files: {
        [WORKFLOW]: job(
          "      - uses: dtolnay/rust-toolchain@master",
          "        with:",
          "          toolchain: nightly",
          "      - uses: Swatinem/rust-cache@v2",
          "      - run: cargo test",
        ),
        ...CRATE,
      },
      errors: [{ line: 9, messageIncludes: "`toolchain: nightly` on `dtolnay/rust-toolchain@master` installs the floating `nightly` Rust toolchain" }],
    },
  ],
});
