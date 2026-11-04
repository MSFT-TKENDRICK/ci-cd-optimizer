import rule from "../../../../src/lint/rules/hermeticity/frozen-lockfile.js";
import { ruleTester } from "../../rule-tester.js";

const LOCK = { "package-lock.json": "{}", "package.json": '{"name":"x"}' };

ruleTester(rule, {
  valid: [
    { files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm ci\n" },
    { name: "installing named packages", files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm install -g npm@11\n" },
    { name: "adding a dependency", files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm i left-pad\n" },
    { name: "pnpm is frozen in CI by default", files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: pnpm install\n" },
    { name: "bun frozen", files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: bun install --frozen-lockfile\n" },
    {
      name: "yarn berry is immutable in CI by default",
      files: { ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: yarn install\n", "yarn.lock": "__metadata:\n" },
    },
    {
      name: "commands inside a block scalar heredoc are still commands, but echo text is not",
      files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: echo 'run npm ci'\n",
    },
  ],
  invalid: [
    {
      files: { ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm install\n", ...LOCK },
      errors: [{ line: 6, messageIncludes: "npm install" }],
      output: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm ci\n",
    },
    {
      name: "multi-line scripts report the right line",
      files: {
        ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: |\n          node -v\n          npm i --no-audit && npm test\n",
        ...LOCK,
      },
      errors: [{ line: 8 }],
      output: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: |\n          node -v\n          npm ci --no-audit && npm test\n",
    },
    {
      name: "no fix without a lockfile",
      files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm install\n",
      errors: [{ messageIncludes: "npm install" }],
      output: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm install\n",
    },
    {
      name: "yarn classic",
      files: { ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: yarn\n", "yarn.lock": "# yarn lockfile v1\n" },
      errors: [{ messageIncludes: "frozen-lockfile" }],
    },
    { name: "pnpm unfrozen", files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: pnpm install --no-frozen-lockfile\n", errors: 1 },
    { name: "bun", files: "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: bun install\n", errors: 1 },
    {
      name: "composite actions are checked",
      files: { "action.yml": "name: setup\nruns:\n  using: composite\n  steps:\n    - run: npm install\n      shell: bash\n" },
      errors: [{ path: "action.yml", line: 5 }],
    },
  ],
});
