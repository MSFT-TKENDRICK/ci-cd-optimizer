import rule from "../../../../src/lint/rules/redundancy/source-cli-with-committed-bundle.js";
import { ruleTester } from "../../rule-tester.js";

const manifest = (cli = "tsx src/bin.ts") => JSON.stringify({ scripts: { cli } });
const nodeAction = "runs:\n  using: node24\n  main: dist-action/index.js\n";
const setupAction = "runs:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n";

const workflow = (steps: string) => `on: push
jobs:
  intake:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
${steps}`;

const viaSetup = (command: string) => `      - uses: ./.github/actions/setup
      - run: ${command}
`;

const files = (steps: string, overrides: Record<string, string | undefined> = {}) => {
  const all: Record<string, string | undefined> = {
    "package.json": manifest(),
    "action.yml": nodeAction,
    ".github/actions/setup/action.yml": setupAction,
    ".github/workflows/ci.yml": workflow(steps),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined));
};

ruleTester(rule, {
  valid: [
    { name: "already runs the committed bundle", files: files(viaSetup("node dist-action/index.js review intake --pr 1")) },
    {
      name: "no root action",
      files: files(viaSetup("npm run --silent cli -- review intake --pr 1"), { "action.yml": undefined }),
    },
    {
      name: "root action is composite",
      files: files(viaSetup("npm run --silent cli -- review intake --pr 1"), { "action.yml": setupAction }),
    },
    {
      name: "script already runs compiled output",
      files: files(viaSetup("npm run --silent cli -- review intake --pr 1"), { "package.json": manifest("node dist/bin.js") }),
    },
    {
      name: "no dependency install",
      files: files("      - run: npm run --silent cli -- review intake --pr 1\n"),
    },
    {
      name: "job also needs installed dependencies",
      files: files(`${viaSetup("npm run --silent cli -- review intake --pr 1")}      - run: npm test\n`),
    },
    {
      name: "job uses github-script",
      files: files(
        `${viaSetup("npm run --silent cli -- review intake --pr 1")}      - uses: actions/github-script@v7\n        with:\n          script: core.info('x')\n`,
      ),
    },
  ],
  invalid: [
    {
      name: "composite setup installs dependencies for a source CLI",
      files: files(viaSetup("npm run --silent cli -- review intake --pr 1")),
      errors: [{ line: 8, path: ".github/workflows/ci.yml", messageIncludes: "dist-action/index.js" }],
    },
    {
      name: "direct npm ci step",
      files: files("      - run: npm ci --no-audit --no-fund\n      - run: npm run cli -- lint . --preset all\n"),
      errors: [{ line: 8, messageIncludes: "tsx src/bin.ts" }],
    },
    {
      name: "guarded invocation inside a multi-line script",
      files: files(`      - uses: ./.github/actions/setup
      - run: |
          set -euo pipefail
          if gh run download 1 --name record && npm run --silent cli -- review intake-artifact --dir record > "$out"; then
            cat "$out"
          fi
`),
      errors: [{ line: 10, messageIncludes: "review intake-artifact" }],
    },
  ],
});
