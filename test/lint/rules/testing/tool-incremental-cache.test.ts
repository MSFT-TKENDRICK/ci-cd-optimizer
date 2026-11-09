import rule from "../../../../src/lint/rules/testing/tool-incremental-cache.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;

ruleTester(rule, {
  valid: [
    { name: "no lint or typecheck tools", files: wf("      - run: npm test\n") },
    {
      name: "eslint cache restored",
      files: wf(
        "      - uses: actions/cache@v4\n        with:\n          path: .eslintcache\n          key: eslint-${{ github.sha }}\n          restore-keys: eslint-\n      - run: npx eslint --cache --cache-location .eslintcache .\n",
      ),
    },
    {
      name: "tsbuildinfo restored",
      files: wf(
        "      - uses: actions/cache@v4\n        with:\n          path: '**/*.tsbuildinfo'\n          key: tsc-${{ github.sha }}\n      - run: npx tsc -b\n",
      ),
    },
    { name: "version probes are ignored", files: wf("      - run: npx tsc --version && npx eslint --help\n") },
    {
      name: "build-tool-cache tools are not duplicated",
      files: wf("      - run: ./gradlew build && mvn -B verify && cargo build\n"),
    },
  ],
  invalid: [
    {
      files: wf("      - run: npx eslint .\n"),
      errors: [{ line: 6, messageIncludes: "ESLint" }],
    },
    {
      name: "tsc and jest without caches",
      files: wf("      - run: npx tsc --noEmit\n      - run: npx jest --ci\n"),
      errors: [{ line: 6, messageIncludes: "tsc" }, { line: 7, messageIncludes: "Jest" }],
    },
  ],
});
