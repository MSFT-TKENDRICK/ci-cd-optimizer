import rule from "../../../../src/lint/rules/toolchains/rust-cargo-incremental-in-ci.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const CRATE = { "Cargo.toml": '[package]\nname = "demo"\n', "Cargo.lock": "version = 4\n" };
const TARGET_CACHE = [
  "      - uses: actions/cache@v4",
  "        with:",
  "          path: |",
  "            ~/.cargo/registry",
  "            target",
  "          key: cargo-${{ hashFiles('Cargo.lock') }}",
];

ruleTester(rule, {
  valid: [
    {
      name: "rust-cache already disables incremental compilation",
      files: { [WORKFLOW]: job("      - uses: Swatinem/rust-cache@v2", "      - run: cargo test"), ...CRATE },
    },
    {
      name: "trap: CARGO_INCREMENTAL=1 without any cache of target/",
      files: { [WORKFLOW]: job("      - run: cargo test", "        env:", "          CARGO_INCREMENTAL: 1"), ...CRATE },
    },
    {
      name: "trap: only the registry is cached",
      files: {
        [WORKFLOW]: job(
          "      - uses: actions/cache@v4",
          "        with:",
          "          path: ~/.cargo/registry",
          "          key: cargo-${{ hashFiles('Cargo.lock') }}",
          "      - run: CARGO_INCREMENTAL=1 cargo test",
        ),
        ...CRATE,
      },
    },
    {
      name: "trap: Rust 1.99+ turns incremental off in CI by default",
      files: {
        [WORKFLOW]: job(...TARGET_CACHE, "      - run: cargo test"),
        ...CRATE,
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.99.0"\n',
      },
    },
    {
      name: "trap: release profile is not incremental",
      files: {
        [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@1.85.0", ...TARGET_CACHE, "      - run: cargo build --release"),
        ...CRATE,
      },
    },
    {
      name: "trap: floating stable toolchain has an unknown default",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@stable", ...TARGET_CACHE, "      - run: cargo test"), ...CRATE },
    },
    {
      name: "actions/cache with CARGO_INCREMENTAL already 0",
      files: {
        [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@1.85.0", ...TARGET_CACHE, "      - run: cargo test", "        env:", "          CARGO_INCREMENTAL: 0"),
        ...CRATE,
      },
    },
  ],
  invalid: [
    {
      name: "step env forces incremental on behind rust-cache",
      files: {
        [WORKFLOW]: job("      - uses: Swatinem/rust-cache@v2", "      - run: cargo test", "        env:", "          CARGO_INCREMENTAL: 1"),
        ...CRATE,
      },
      errors: [
        {
          line: 10,
          path: WORKFLOW,
          messageIncludes: "`CARGO_INCREMENTAL: 1` forces incremental compilation on for `cargo test` in a job that caches `target/`: Swatinem/rust-cache normally sets `CARGO_INCREMENTAL=0` and deletes incremental artifacts before saving; the data can still be reused by subsequent compilations within this job.",
        },
      ],
      output: null,
    },
    {
      name: "job env forces incremental on while actions/cache saves target/",
      files: {
        [WORKFLOW]: yml(
          "on: push",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-24.04",
          "    env:",
          '      CARGO_INCREMENTAL: "1"',
          "    steps:",
          ...TARGET_CACHE,
          "      - run: cargo build",
        ),
        ...CRATE,
      },
      errors: [{ line: 6, messageIncludes: "covered by `actions/cache`'s configured path" }],
      output: null,
    },
    {
      name: "inline assignment on the command",
      files: { [WORKFLOW]: job("      - uses: Swatinem/rust-cache@v2", "      - run: CARGO_INCREMENTAL=1 cargo clippy"), ...CRATE },
      errors: [{ line: 8, messageIncludes: "`CARGO_INCREMENTAL=1` forces incremental compilation on for `CARGO_INCREMENTAL=1 cargo clippy`" }],
      output: null,
    },
    {
      name: "build.incremental = true in .cargo/config.toml with a target/ cache",
      files: {
        [WORKFLOW]: job(...TARGET_CACHE, "      - run: cargo test"),
        ...CRATE,
        ".cargo/config.toml": "[build]\nincremental = true\n",
      },
      errors: [{ line: 13, messageIncludes: "`.cargo/config.toml` sets `build.incremental = true`" }],
    },
    {
      name: "pre-1.99 toolchain with a target/ cache and no override",
      files: { [WORKFLOW]: job("      - uses: dtolnay/rust-toolchain@1.85.0", ...TARGET_CACHE, "      - run: cargo test"), ...CRATE },
      errors: [{ line: 8, messageIncludes: "on Rust 1.85, where incremental compilation is on by default" }],
    },
  ],
});
