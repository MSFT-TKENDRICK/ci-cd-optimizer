import rule from "../../../../src/lint/rules/redundancy/duplicate-command.js";
import { ruleTester } from "../../rule-tester.js";

const job = (steps: string) => `on: push
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
${steps}`;

ruleTester(rule, {
  valid: [
    { name: "distinct commands", files: job("      - run: npm ci\n      - run: npm test\n      - run: npm run build\n") },
    { name: "trivial commands", files: job("      - run: echo start && ls -la\n      - run: echo start && ls -la\n") },
    { name: "mkdir and rm", files: job("      - run: mkdir -p out/reports\n      - run: mkdir -p out/reports\n") },
    {
      name: "different working directories",
      files: job("      - run: npm ci\n        working-directory: web\n      - run: npm ci\n        working-directory: api\n"),
    },
    {
      name: "script changes directory",
      files: job("      - run: |\n          npm install\n          cd packages/app\n          npm install\n"),
    },
    {
      name: "loops",
      files: job("      - run: |\n          for i in 1 2 3; do\n            npm test\n          done\n          npm test\n"),
    },
    { name: "retry with ||", files: job("      - run: npm test || npm test\n") },
    {
      name: "action between repeats",
      files: job("      - run: npm run build\n      - uses: actions/checkout@v4\n        with:\n          ref: main\n      - run: npm run build\n"),
    },
    {
      name: "GITHUB_ENV write between repeats",
      files: job('      - run: npm run build\n      - run: echo "MODE=prod" >> "$GITHUB_ENV"\n      - run: npm run build\n'),
    },
    {
      name: "different step env",
      files: job("      - run: npm run build\n        env:\n          MODE: a\n      - run: npm run build\n        env:\n          MODE: b\n"),
    },
    {
      name: "different conditions",
      files: job("      - run: npm run deploy\n        if: success()\n      - run: npm run deploy\n        if: failure()\n"),
    },
  ],
  invalid: [
    {
      files: job("      - run: npm ci\n      - run: npm test\n      - run: npm ci\n"),
      errors: [{ line: 8, messageIncludes: "line 6" }],
    },
    {
      name: "within a multi-line script",
      files: job("      - run: |\n          pip install -r requirements.txt\n          pytest\n          pip install -r requirements.txt\n"),
      errors: [{ line: 9 }],
    },
    {
      name: "three repeats",
      files: job("      - run: go test ./...\n      - run: go test ./...\n      - run: go  test  ./...\n"),
      errors: 2,
    },
  ],
});
