import rule from "../../../../src/lint/rules/nix/max-jobs-pinned-low.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const head = (runner = "ubuntu-latest") => ["on: push", "jobs:", "  build:", `    runs-on: ${runner}`, "    steps:"];
const job = (...steps: string[]) => yml(...head(), ...steps);
const install = "      - uses: cachix/install-nix-action@v31";

ruleTester(rule, {
  valid: [
    {
      name: "max-jobs = auto",
      files: job(install, "        with:", "          extra_nix_config: |", "            max-jobs = auto", "      - run: nix build .#default"),
    },
    {
      name: "max-jobs = 0 with remote builders",
      files: job(
        install,
        "        with:",
        "          extra_nix_config: |",
        "            max-jobs = 0",
        "            builders = ssh://builder x86_64-linux",
        "      - run: nix build .#default",
      ),
    },
    {
      name: "a self-hosted runner",
      files: yml(...head("[self-hosted, linux]"), install, "        with:", "          extra_nix_config: max-jobs = 1", "      - run: nix build .#default"),
    },
    {
      name: "a value above the threshold",
      files: job(install, "      - run: nix build -j 4 .#default"),
    },
    {
      name: "explicit cores tuning makes it deliberate",
      files: job(install, "        with:", "          extra_nix_config: |", "            max-jobs = 1", "            cores = 0", "      - run: nix build .#default"),
    },
    {
      name: "make -j1 inside the dev shell is not a Nix option",
      files: job(install, "      - run: nix develop -c make -j1"),
    },
    {
      name: "an installer value of 1 overridden by NIX_CONFIG auto",
      files: yml(
        ...head(),
        "      - uses: DeterminateSystems/nix-installer-action@v21",
        "        with:",
        "          extra-conf: max-jobs = 1",
        "      - run: nix build .#default",
        "        env:",
        "          NIX_CONFIG: max-jobs = auto",
      ),
    },
    {
      name: "max-substitution-jobs is a different setting",
      files: job(install, "        with:", "          extra_nix_config: max-substitution-jobs = 1", "      - run: nix build .#default"),
    },
    {
      name: "a raised threshold still accepts 3",
      options: { max: 2 },
      files: job(install, "      - run: nix build --max-jobs 3 .#default"),
    },
    {
      name: "a matrix runner that includes self-hosted",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    strategy:",
        "      matrix:",
        "        os: [ubuntu-latest, nixos-builder]",
        "    runs-on: ${{ matrix.os }}",
        "    steps:",
        install,
        "      - run: nix build -j1 .#default",
      ),
    },
    {
      name: "a job without Nix",
      files: job("      - run: make -j 1"),
    },
  ],
  invalid: [
    {
      name: "installer extra_nix_config block",
      files: job(install, "        with:", "          extra_nix_config: |", "            max-jobs = 1", "      - run: nix build .#default"),
      errors: [{ line: 9, messageIncludes: "`max-jobs = 1` in the `extra_nix_config` input of cachix/install-nix-action" }],
      output: job(install, "        with:", "          extra_nix_config: |", "            max-jobs = auto", "      - run: nix build .#default"),
    },
    {
      name: "nix build -j 1",
      files: job(install, "      - run: nix build -j 1 .#default"),
      errors: [{ line: 7, messageIncludes: "one local build at a time on GitHub-hosted `ubuntu-latest`" }],
      output: job(install, "      - run: nix build -j auto .#default"),
    },
    {
      name: "--max-jobs=1",
      files: job(install, "      - run: nix flake check --max-jobs=1"),
      errors: [{ line: 7, messageIncludes: "`max-jobs 1` in the `nix flake check` command line" }],
      output: job(install, "      - run: nix flake check --max-jobs=auto"),
    },
    {
      name: "attached -j1 is rewritten with a space",
      files: job(install, "      - run: nix-build -j1 default.nix"),
      errors: [{ line: 7, messageIncludes: "`max-jobs 1`" }],
      output: job(install, "      - run: nix-build -j auto default.nix"),
    },
    {
      name: "job-level NIX_CONFIG block located at the exact line",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    env:",
        "      NIX_CONFIG: |",
        "        experimental-features = nix-command flakes",
        "        max-jobs = 1",
        "    steps:",
        install,
        "      - run: nix build .#default",
      ),
      errors: [{ line: 8, messageIncludes: "the job's `NIX_CONFIG`" }],
      output: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    env:",
        "      NIX_CONFIG: |",
        "        experimental-features = nix-command flakes",
        "        max-jobs = auto",
        "    steps:",
        install,
        "      - run: nix build .#default",
      ),
    },
    {
      name: "--option max-jobs 2 with a raised threshold",
      options: { max: 2 },
      files: job(install, "      - run: nix build --option max-jobs 2 .#default"),
      errors: [{ line: 7, messageIncludes: "2 concurrent local builds" }],
      output: job(install, "      - run: nix build --option max-jobs auto .#default"),
    },
    {
      name: "a shell write to nix.conf",
      files: job(install, '      - run: echo "max-jobs = 1" | sudo tee -a /etc/nix/nix.conf'),
      errors: [{ line: 7, messageIncludes: "a shell write to nix.conf" }],
      output: job(install, '      - run: echo "max-jobs = auto" | sudo tee -a /etc/nix/nix.conf'),
    },
    {
      name: "quick-install single-line nix_conf",
      files: yml(
        ...head("macos-14"),
        "      - uses: nixbuild/nix-quick-install-action@v30",
        "        with:",
        "          nix_conf: max-jobs = 1",
        "      - run: nix build .#default",
      ),
      errors: [{ line: 8, messageIncludes: "the `nix_conf` input of nixbuild/nix-quick-install-action" }],
      output: yml(
        ...head("macos-14"),
        "      - uses: nixbuild/nix-quick-install-action@v30",
        "        with:",
        "          nix_conf: max-jobs = auto",
        "      - run: nix build .#default",
      ),
    },
    {
      name: "a nested nix build inside nix develop",
      files: job(install, "      - run: nix develop -c nix build -j 1 .#default"),
      errors: [{ line: 7, messageIncludes: "the `nix build` command line" }],
      output: job(install, "      - run: nix develop -c nix build -j auto .#default"),
    },
  ],
});
