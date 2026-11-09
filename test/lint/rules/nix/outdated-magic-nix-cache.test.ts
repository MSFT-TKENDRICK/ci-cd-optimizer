import rule from "../../../../src/lint/rules/nix/outdated-magic-nix-cache.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;
const job = (...steps: string[]) => yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", ...steps);
const SHA = "a3a2b6d8e7f0c1b2a3d4e5f60718293a4b5c6d7e";

ruleTester(rule, {
  valid: [
    { name: "first fixed major", files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v10") },
    { name: "current major", files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v13") },
    { name: "branch ref", files: job("      - uses: DeterminateSystems/magic-nix-cache-action@main") },
    { name: "uncommented SHA cannot be dated", files: job(`      - uses: DeterminateSystems/magic-nix-cache-action@${SHA}`) },
    { name: "SHA commented with a fixed release", files: job(`      - uses: DeterminateSystems/magic-nix-cache-action@${SHA} # v11.0.0`) },
    { name: "other Determinate action with an old major", files: job("      - uses: DeterminateSystems/nix-installer-action@v4") },
  ],
  invalid: [
    {
      name: "plain major tag is fixed",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v17", "      - uses: DeterminateSystems/magic-nix-cache-action@v8"),
      errors: [{ line: 7, messageIncludes: "pinned to `v8`" }],
      output: job("      - uses: DeterminateSystems/nix-installer-action@v17", "      - uses: DeterminateSystems/magic-nix-cache-action@v15"),
    },
    {
      name: "lower-case owner is fixed",
      files: job("      - uses: determinatesystems/magic-nix-cache-action@v2"),
      errors: [{ line: 6, messageIncludes: "`v2`" }],
      output: job("      - uses: determinatesystems/magic-nix-cache-action@v15"),
    },
    {
      name: "full version tag is reported without a fix",
      files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v9.1.0"),
      errors: [{ line: 6, messageIncludes: "`v9.1.0`" }],
      output: job("      - uses: DeterminateSystems/magic-nix-cache-action@v9.1.0"),
    },
    {
      name: "SHA pin resolved via its version comment",
      files: job("      - name: cache", `        uses: DeterminateSystems/magic-nix-cache-action@${SHA} # v7`),
      errors: [{ line: 7, messageIncludes: "a SHA commented as v7" }],
    },
  ],
});
