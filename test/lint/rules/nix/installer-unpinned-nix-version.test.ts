import rule from "../../../../src/lint/rules/nix/installer-unpinned-nix-version.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]) => yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps, "      - run: nix build");

ruleTester(rule, {
  valid: [
    { name: "determinate-nix-action pins Nix through its tag", files: job("      - uses: DeterminateSystems/determinate-nix-action@v3.24.2") },
    { name: "floating branch ref makes no reproducibility claim", files: job("      - uses: DeterminateSystems/nix-installer-action@main") },
    {
      name: "source-tag pins the installer",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v23", "        with:", "          source-tag: v3.11.3"),
    },
    {
      name: "deprecated nix-installer-tag input also pins",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v9", "        with:", "          nix-installer-tag: v0.16.1"),
    },
    {
      name: "explicit nix-package-url",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v23", "        with:", "          nix-package-url: https://releases.nixos.org/nix/nix-2.24.9/nix-2.24.9-x86_64-linux.tar.xz"),
    },
    { name: "other installers are out of scope", files: job("      - uses: cachix/install-nix-action@v31") },
  ],
  invalid: [
    {
      name: "major tag",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v23"),
      errors: [{ line: 6, messageIncludes: "`DeterminateSystems/nix-installer-action@v23` is pinned, but the action downloads the most recent Nix installer" }],
    },
    {
      name: "SHA pin with unrelated inputs",
      files: job(
        "      - uses: DeterminateSystems/nix-installer-action@21a544727d0c62386e78b4befe52d19ad12692e3 # v17",
        "        with:",
        "          extra-conf: max-jobs = auto",
      ),
      errors: [{ line: 6, messageIncludes: "nix-installer-action@21a544727d0c…` is pinned" }],
    },
    {
      name: "upstream Nix via determinate: false",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v16.1.0", "        with:", "          determinate: false"),
      errors: [{ line: 6, messageIncludes: "@v16.1.0" }],
    },
    {
      name: "composite action",
      files: {
        ".github/actions/setup-nix/action.yml": yml(
          "name: setup",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: DeterminateSystems/nix-installer-action@v20",
        ),
      },
      errors: [{ path: ".github/actions/setup-nix/action.yml", line: 5, messageIncludes: "@v20" }],
    },
  ],
});
