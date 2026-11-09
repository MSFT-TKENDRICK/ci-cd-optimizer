import rule from "../../../../src/lint/rules/testing/cache-disabled-install.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const node = "      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n";
const python = "      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'\n          cache: pip\n";

ruleTester(rule, {
  valid: [
    { name: "cache used normally", files: wf(`${node}      - run: npm ci\n`) },
    { name: "no cache restored, nothing to waste", files: wf("      - run: npm cache clean --force && npm ci\n") },
    { name: "pip --no-cache-dir without a pip cache", files: wf("      - run: pip install --no-cache-dir -r requirements.txt\n") },
    {
      name: "Dockerfiles are out of scope",
      files: { ".github/workflows/ci.yml": wf(`${python}      - run: docker build .\n`), Dockerfile: "FROM python:3.12\nRUN pip install --no-cache-dir flask\n" },
    },
  ],
  invalid: [
    {
      files: wf(`${node}      - run: npm cache clean --force && npm ci\n`),
      errors: [{ line: 9, messageIncludes: "npm cache clean" }],
    },
    {
      name: "pip --no-cache-dir with setup-python pip cache",
      files: wf(`${python}      - run: pip install --no-cache-dir -r requirements.txt\n`),
      errors: [{ line: 10, messageIncludes: "--no-cache-dir" }],
    },
    {
      name: "npm ci with a temporary cache",
      files: wf(`${node}      - run: npm ci --cache /tmp/empty-cache\n`),
      errors: 1,
    },
    {
      name: "pnpm store prune",
      files: wf("      - uses: actions/setup-node@v4\n        with:\n          cache: pnpm\n      - run: pnpm install && pnpm store prune\n"),
      errors: 1,
    },
  ],
});
