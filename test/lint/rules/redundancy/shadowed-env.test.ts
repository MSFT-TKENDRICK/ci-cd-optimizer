import rule from "../../../../src/lint/rules/redundancy/shadowed-env.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "different values",
      files: `on: push
env:
  NODE_ENV: test
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      NODE_ENV: production
    steps:
      - run: npm run build
`,
    },
    {
      name: "step restores workflow value overridden by the job",
      files: `on: push
env:
  MODE: a
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      MODE: b
    steps:
      - run: ./build.sh
        env:
          MODE: a
`,
    },
    {
      name: "version-like values are compared as written",
      files: `on: push
env:
  PY: 3.1
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      PY: 3.10
    steps:
      - run: ./build.sh
`,
    },
    {
      name: "expressions with per-job contexts",
      files: `on: push
env:
  TARGET: \${{ matrix.target }}
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      TARGET: \${{ matrix.target }}
    steps:
      - run: ./build.sh
`,
    },
    {
      name: "after a GITHUB_ENV write",
      files: `on: push
env:
  MODE: a
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "MODE=b" >> "$GITHUB_ENV"
      - run: ./build.sh
        env:
          MODE: a
`,
    },
  ],
  invalid: [
    {
      name: "job repeats workflow env",
      files: `on: push
env:
  NODE_ENV: test
  CI: true
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      NODE_ENV: test
      EXTRA: "1"
    steps:
      - run: npm run build
`,
      errors: [{ line: 9, messageIncludes: "NODE_ENV=test" }],
      output: `on: push
env:
  NODE_ENV: test
  CI: true
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      EXTRA: "1"
    steps:
      - run: npm run build
`,
    },
    {
      name: "only entry removes the env block",
      files: `on: push
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - run: ./build.sh
`,
      errors: 1,
      output: `on: push
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: ./build.sh
`,
    },
    {
      name: "step repeats job env",
      files: `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      GOFLAGS: -mod=readonly
    steps:
      - run: go build ./...
        env:
          GOFLAGS: -mod=readonly
          CGO_ENABLED: "0"
`,
      errors: [{ line: 10 }],
      output: `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      GOFLAGS: -mod=readonly
    steps:
      - run: go build ./...
        env:
          CGO_ENABLED: "0"
`,
    },
    {
      name: "flow map is reported without a fix",
      files: `on: push
env:
  CI: "true"
jobs:
  build:
    runs-on: ubuntu-24.04
    env: { CI: "true" }
    steps:
      - run: ./build.sh
`,
      errors: 1,
      output: `on: push
env:
  CI: "true"
jobs:
  build:
    runs-on: ubuntu-24.04
    env: { CI: "true" }
    steps:
      - run: ./build.sh
`,
    },
  ],
});
