import rule from "../../../../src/lint/rules/testing/watch-mode-in-ci.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;

ruleTester(rule, {
  valid: [
    { name: "plain vitest run", files: wf("      - run: npx vitest run\n") },
    { name: "jest without watch", files: wf("      - run: npx jest --ci\n") },
    { name: "ng test with watch disabled", files: wf("      - run: npx ng test --watch=false --browsers=ChromeHeadless\n") },
    { name: "karma single run", files: wf("      - run: npx karma start --single-run\n") },
    {
      name: "package script without watch",
      files: { ".github/workflows/ci.yml": wf("      - run: npm test\n"), "package.json": '{"scripts":{"test":"vitest run"}}' },
    },
  ],
  invalid: [
    {
      files: wf("      - run: npx jest --watchAll\n"),
      errors: [{ line: 6, messageIncludes: "watch mode" }],
    },
    { name: "vitest watch subcommand", files: wf("      - run: npx vitest watch\n"), errors: 1 },
    { name: "ng test defaults to watch", files: wf("      - run: npx ng test\n"), errors: 1 },
    { name: "karma start without single run", files: wf("      - run: npx karma start karma.conf.js\n"), errors: 1 },
    {
      name: "watch flag inside a package script",
      files: { ".github/workflows/ci.yml": wf("      - run: npm test\n"), "package.json": '{"scripts":{"test":"jest --watch"}}' },
      errors: [{ line: 6, messageIncludes: "package script" }],
    },
  ],
});
