import rule from "../../../../src/lint/rules/testing/playwright-browser-cache.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string, extra = "") => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n${extra}    steps:\n${body}`;

ruleTester(rule, {
  valid: [
    { name: "no playwright", files: wf("      - run: npm test\n") },
    {
      name: "browsers cached with actions/cache",
      files: wf(
        "      - uses: actions/cache@v4\n        with:\n          path: ~/.cache/ms-playwright\n          key: pw-${{ hashFiles('package-lock.json') }}\n      - run: npx playwright install --with-deps\n",
      ),
    },
    {
      name: "official playwright container image",
      files: wf("      - run: npx playwright install\n", "    container: mcr.microsoft.com/playwright:v1.48.0-noble\n"),
    },
    { name: "install-deps only installs OS packages", files: wf("      - run: npx playwright install-deps\n") },
  ],
  invalid: [
    {
      files: wf("      - run: npm ci\n      - run: npx playwright install --with-deps\n      - run: npx playwright test\n"),
      errors: [{ line: 7, messageIncludes: "No browser cache or Playwright container image was detected" }],
    },
    {
      name: "through pnpm exec",
      files: wf("      - run: pnpm exec playwright install chromium\n"),
      errors: 1,
    },
    {
      name: "unrelated cache does not count",
      files: wf(
        "      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: npm\n      - run: npx playwright install\n",
      ),
      errors: [{ line: 10 }],
    },
  ],
});
