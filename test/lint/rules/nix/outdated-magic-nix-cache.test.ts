import rule from "../../../../src/lint/rules/nix/outdated-magic-nix-cache.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;
const job = (...steps: string[]) => yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", ...steps);
const SHA = "a3a2b6d8e7f0c1b2a3d4e5f60718293a4b5c6d7e";

ruleTester(rule, {
  valid: [
    { name: "first wrapper release documenting restored support", files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v11") },
    { name: "current major", files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v13") },
    { name: "branch ref", files: job("      - uses: DeterminateSystems/magic-nix-cache-action@main") },
    { name: "uncommented SHA cannot be dated", files: job(`      - uses: DeterminateSystems/magic-nix-cache-action@${SHA}`) },
    { name: "SHA commented with a fixed release", files: job(`      - uses: DeterminateSystems/magic-nix-cache-action@${SHA} # v11.0.0`) },
    { name: "other Determinate action with an old major", files: job("      - uses: DeterminateSystems/nix-installer-action@v4") },
  ],
  invalid: [
    {
      name: "v10 still precedes the v11 restored-support release",
      files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v10"),
      errors: [{ line: 6, messageIncludes: "magic-nix-cache-action is pinned to `v10`, predating v11's restored support and daemon context changes. This does not establish a cache failure; check the host, downloaded binary and actual cache logs before upgrading." }],
      output: null,
    },
    {
      name: "plain major tag receives an advisory upgrade recommendation",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v17", "      - uses: DeterminateSystems/magic-nix-cache-action@v8"),
      errors: [{ line: 7, messageIncludes: "pinned to `v8`" }],
      output: null,
    },
    {
      name: "lower-case owner is recognized without an automatic upgrade",
      files: job("      - uses: determinatesystems/magic-nix-cache-action@v2"),
      errors: [{ line: 6, messageIncludes: "`v2`" }],
      output: null,
    },
    {
      name: "full version tag is reported without a fix",
      files: job("      - uses: DeterminateSystems/magic-nix-cache-action@v9.1.0"),
      errors: [{ line: 6, messageIncludes: "`v9.1.0`" }],
      output: null,
    },
    {
      name: "SHA pin resolved via its version comment",
      files: job("      - name: cache", `        uses: DeterminateSystems/magic-nix-cache-action@${SHA} # v7`),
      errors: [{ line: 7, messageIncludes: "a SHA commented as v7" }],
    },
  ],
});
