import rule from "../../../../src/lint/rules/nix/raw-store-cache.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;
const job = (...steps: string[]) => yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", ...steps);
const action = (...steps: string[]) => yml("name: setup", "runs:", "  using: composite", "  steps:", ...steps);

ruleTester(rule, {
  valid: [
    {
      name: "user-level Nix cache directory",
      files: job("      - uses: actions/cache@v4", "        with:", "          path: ~/.cache/nix", "          key: nix-eval"),
    },
    {
      name: "store only appears as an exclusion",
      files: job(
        "      - uses: actions/cache@v4",
        "        with:",
        "          path: |",
        "            ~/.cache",
        "            !/nix/store",
        "          key: k",
      ),
    },
    {
      name: "Nix-aware cache action",
      files: job(
        "      - uses: nix-community/cache-nix-action@v7",
        "        with:",
        "          primary-key: nix-${{ hashFiles('flake.lock') }}",
      ),
    },
    {
      name: "paths that merely start with /nix",
      files: job(
        "      - uses: actions/cache@v4",
        "        with:",
        "          path: |",
        "            /nixos-config",
        "            /nix-export/store",
        "          key: k",
      ),
    },
    {
      name: "store path mentioned in a run step",
      files: job("      - run: du -sh /nix/store"),
    },
  ],
  invalid: [
    {
      name: "actions/cache of /nix/store",
      files: job("      - uses: actions/cache@v4", "        with:", "          path: /nix/store", "          key: k"),
      errors: [{ line: 8, messageIncludes: "actions/cache caches `/nix/store`" }],
    },
    {
      name: "multi-line path reports the first store entry and names all of them",
      files: job(
        "      - uses: actions/cache@v4",
        "        with:",
        "          path: |",
        "            ~/.cache/pip",
        "            /nix/store",
        "            /nix/var/nix/db",
        "          key: k",
      ),
      errors: [{ line: 10, messageIncludes: "`/nix/store`, `/nix/var/nix/db`" }],
    },
    {
      name: "quoted path with trailing slash on a drop-in replacement",
      files: job("      - uses: useblacksmith/cache@v5", "        with:", '          path: "/nix/store/"', "          key: k"),
      errors: [{ line: 8, messageIncludes: "useblacksmith/cache" }],
    },
    {
      name: "restore-only variant in a composite action",
      files: {
        ".github/actions/setup/action.yml": action(
          "    - uses: actions/cache/restore@v4",
          "      with:",
          "        path: /nix",
          "        key: k",
        ),
      },
      errors: [{ path: ".github/actions/setup/action.yml", line: 7, messageIncludes: "`/nix`" }],
    },
  ],
});
