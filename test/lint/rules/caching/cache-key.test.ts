import rule from "../../../../src/lint/rules/caching/cache-key.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const cache = (withBody: string, action = "actions/cache@v6") => `      - uses: ${action}\n        with:\n${withBody}`;

ruleTester(rule, {
  valid: [
    {
      name: "hashed key",
      files: wf(cache("          path: ~/.npm\n          key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}\n")),
    },
    {
      name: "volatile key with restore-keys",
      files: wf(cache("          path: .cache\n          key: build-${{ github.sha }}\n          restore-keys: build-\n")),
    },
    {
      name: "cache/save with a run-scoped key is expected",
      files: wf(cache("          path: .cache\n          key: build-${{ github.run_id }}\n", "actions/cache/save@v6")),
    },
    {
      name: "key computed by an earlier step is unknown",
      files: wf(cache("          path: .cache\n          key: ${{ steps.k.outputs.key }}\n")),
    },
    {
      name: "node_modules cache with npm install skipped on cache hit",
      files: wf(
        `      - id: c\n${cache("          path: node_modules\n          key: nm-${{ hashFiles('package-lock.json') }}\n").replace("      - uses", "        uses")}      - if: steps.c.outputs.cache-hit != 'true'\n        run: npm ci\n`,
      ),
    },
    {
      name: "node_modules cache without npm ci",
      files: wf(`${cache("          path: node_modules\n          key: nm-${{ hashFiles('yarn.lock') }}\n")}      - run: yarn install --frozen-lockfile\n`),
    },
  ],
  invalid: [
    {
      name: "static key",
      files: wf(cache("          path: ~/.npm\n          key: npm-cache\n")),
      errors: [{ line: 9, messageIncludes: "static" }],
    },
    {
      name: "static key on cache/restore",
      files: wf(cache("          path: ~/.npm\n          key: deps\n", "actions/cache/restore@v6")),
      errors: [{ line: 9, messageIncludes: "does not encode dependency changes" }],
    },
    {
      name: "github.sha without restore-keys",
      files: wf(cache("          path: .cache\n          key: build-${{ runner.os }}-${{ github.sha }}\n")),
      errors: [{ line: 9, messageIncludes: "github.sha" }],
    },
    {
      name: "run_id without restore-keys",
      files: wf(cache("          path: .cache\n          key: build-${{ github.run_id }}\n")),
      errors: [{ messageIncludes: "github.run_id" }],
    },
    {
      name: "node_modules cached before npm ci",
      files: wf(`${cache("          path: node_modules\n          key: nm-${{ hashFiles('package-lock.json') }}\n")}      - run: npm ci\n`),
      errors: [{ line: 8, messageIncludes: "node_modules" }],
    },
    {
      name: "node_modules among several paths, npm clean-install in a later script",
      files: wf(
        `${cache("          path: |\n            ~/.cache/x\n            web/node_modules\n          key: nm-${{ hashFiles('**/package-lock.json') }}\n")}      - run: |\n          cd web\n          npm clean-install --no-audit\n`,
      ),
      errors: 1,
    },
    {
      name: "static key and node_modules both reported",
      files: wf(`${cache("          path: node_modules\n          key: modules\n")}      - run: npm ci\n`),
      errors: [{ line: 8, messageIncludes: "node_modules" }, { line: 9, messageIncludes: "static" }],
    },
    {
      name: "composite action",
      files: {
        "action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v6\n      with:\n        path: .cache\n        key: fixed\n",
      },
      errors: [{ path: "action.yml", line: 7 }],
    },
  ],
});
