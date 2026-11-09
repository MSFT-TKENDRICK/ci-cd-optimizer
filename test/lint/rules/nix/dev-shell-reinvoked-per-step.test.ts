import rule from "../../../../src/lint/rules/nix/dev-shell-reinvoked-per-step.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const head = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31"];
const job = (...steps: string[]) => yml(...head, ...steps);

ruleTester(rule, {
  valid: [
    { name: "a single dev-shell step", files: job("      - run: nix develop --command cargo test", "      - run: cargo fmt --check") },
    {
      name: "job defaults already run every step in the dev shell",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        "      run:",
        "        shell: nix develop --command bash -e {0}",
        "    steps:",
        "      - run: nix develop -c cargo fmt --check",
        "      - run: nix develop -c cargo test",
      ),
    },
    {
      name: "different dev shells are different environments",
      files: job("      - run: nix develop .#lint -c cargo clippy", "      - run: nix develop .#test -c cargo test"),
    },
    {
      name: "different working directories",
      files: job(
        "      - run: nix develop -c make",
        "        working-directory: frontend",
        "      - run: nix develop -c make",
        "        working-directory: backend",
      ),
    },
    {
      name: "nix-develop action already loads the shell",
      files: job("      - uses: nicknovitski/nix-develop@v1", "      - run: nix develop -c cargo test", "      - run: nix develop -c cargo doc"),
    },
    { name: "nix develop without a command (interactive) is not counted", files: job("      - run: nix develop --profile dev", "      - run: nix develop --profile dev2") },
    { name: "two commands in one step are one start each but one step", files: job("      - run: |", "          nix develop -c make", "          nix develop -c make test") },
    {
      name: "option threshold",
      options: { minSteps: 3 },
      files: job("      - run: nix develop -c make", "      - run: nix develop -c make test"),
    },
  ],
  invalid: [
    {
      name: "two nix develop --command steps",
      files: job("      - run: nix develop --command cargo clippy", "      - run: cargo build", "      - run: nix develop . --command cargo test"),
      errors: [{ line: 7, messageIncludes: "`nix develop` is started separately in 2 steps of job `build` (lines 7, 9)" }],
    },
    {
      name: "nix-shell --run per step",
      files: job("      - run: nix-shell --run 'make'", "      - run: nix-shell --run 'make check'"),
      errors: [{ line: 7, messageIncludes: "`nix-shell` is started separately in 2 steps" }],
    },
    {
      name: "per-step shell: nix develop",
      files: job(
        "      - run: cargo test",
        "        shell: nix develop .#ci --command bash -e {0}",
        "      - run: cargo doc",
        "        shell: nix develop .#ci --command bash -e {0}",
      ),
      errors: [{ line: 7, messageIncludes: "First: `shell: nix develop .#ci --command bash -e {0}`" }],
    },
    {
      name: "composite action step counts toward the job",
      files: {
        ".github/workflows/ci.yml": job("      - uses: ./.github/actions/lint", "      - run: nix develop -c cargo test"),
        ".github/actions/lint/action.yml": yml(
          "name: lint",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - run: nix develop -c cargo clippy",
          "      shell: bash",
        ),
      },
      errors: [{ path: ".github/actions/lint/action.yml", line: 5, messageIncludes: "2 steps of job `build`" }],
    },
    {
      name: "default installable spellings are the same shell",
      files: job("      - run: nix develop .#default -c make", "      - run: nix develop -c make test", "      - run: nix develop ./. -c make docs"),
      errors: [{ line: 7, messageIncludes: "3 steps" }],
    },
  ],
});
