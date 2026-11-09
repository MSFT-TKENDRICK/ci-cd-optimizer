import rule from "../../../../src/lint/rules/nix/separate-nix-build-invocations.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const head = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31"];
const job = (...steps: string[]) => yml(...head, ...steps);

ruleTester(rule, {
  valid: [
    { name: "a single multi-installable build", files: job("      - run: nix build .#server .#client") },
    {
      name: "a later step reads the result symlink",
      files: job("      - run: nix build .#server", "      - run: nix build .#client", "      - run: ls -l result/bin"),
    },
    {
      name: "explicit out links name each output",
      files: job("      - run: nix build .#server -o server", "      - run: nix build .#client -o client"),
    },
    {
      name: "shell expansion in the installable",
      files: job("      - run: nix build .#${{ matrix.package }}", "      - run: nix build .#docs"),
    },
    {
      name: "different step conditions",
      files: job("      - run: nix build .#server", "      - run: nix build .#client", "        if: github.event_name == 'push'"),
    },
    {
      name: "an interleaved command separates the builds",
      files: job("      - run: nix build .#server", "      - run: ./scripts/smoke-test.sh", "      - run: nix build .#client"),
    },
    {
      name: "different build options",
      files: job("      - run: nix build .#server", "      - run: nix build --option sandbox relaxed .#client"),
    },
    {
      name: "continue-on-error on one build step",
      files: job("      - run: nix build .#server", "      - run: nix build .#flaky", "        continue-on-error: true"),
    },
    {
      name: "a uses: step between the builds",
      files: job("      - run: nix build .#server", "      - uses: actions/upload-artifact@v4", "      - run: nix build .#client"),
    },
    {
      name: "print-out-paths output is consumed",
      files: job("      - run: |", "          nix build --print-out-paths .#server", "          nix build --print-out-paths .#client"),
    },
  ],
  invalid: [
    {
      name: "builds in separate steps",
      files: job("      - run: nix build .#server", "      - run: nix build .#client", "      - run: nix build .#docs"),
      errors: [{ line: 7, messageIncludes: "3 consecutive `nix build` commands in job `build` (lines 7, 8, 9)" }],
    },
    {
      name: "builds chained with && on one line",
      files: job("      - run: nix build -L .#a && nix build -L .#b"),
      errors: [{ line: 7, messageIncludes: "`nix build -L .#a .#b` evaluates once" }],
    },
    {
      name: "builds in one block script",
      files: job("      - run: |", "          nix build --no-link .#a", "          nix build --no-link .#b", "      - run: ls result"),
      errors: [{ line: 8, messageIncludes: "`nix build --no-link .#a .#b`" }],
    },
    {
      name: "two groups split by a test command",
      files: job(
        "      - run: nix build .#a",
        "      - run: nix build .#b",
        "      - run: make test",
        "      - run: nix build .#c",
        "      - run: nix build .#d",
      ),
      errors: [
        { line: 7, messageIncludes: "`nix build .#a .#b`" },
        { line: 10, messageIncludes: "`nix build .#c .#d`" },
      ],
    },
  ],
});
