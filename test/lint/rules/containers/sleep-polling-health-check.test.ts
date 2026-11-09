import rule from "../../../../src/lint/rules/containers/sleep-polling-health-check.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const withServices = (services: string[], ...steps: string[]): string =>
  yml(
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-24.04",
    "    services:",
    ...services.map((line) => `      ${line}`),
    "    steps:",
    ...steps.map((line) => `      ${line}`),
  );

const POSTGRES = ["postgres:", "  image: postgres:16", "  env:", "    POSTGRES_PASSWORD: postgres"];

ruleTester(rule, {
  valid: [
    {
      name: "service already has a health check",
      files: withServices(
        [...POSTGRES, "  options: >-", "    --health-cmd pg_isready", "    --health-interval 2s", "    --health-retries 30"],
        "- run: sleep 15",
        "- run: npm test",
      ),
    },
    {
      name: "short sleep below the threshold",
      files: withServices(POSTGRES, "- run: sleep 2", "- run: npm test"),
    },
    {
      name: "readiness polling loop",
      files: withServices(POSTGRES, "- run: |", "    until pg_isready -h localhost; do", "      sleep 5", "    done"),
    },
    {
      name: "no services",
      files: yml("on: push", "jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - run: sleep 30"),
    },
    {
      name: "sleep waits for a process the job started in the background",
      files: withServices(POSTGRES, "- run: |", "    npm run start:api &", "    sleep 10", "- run: npm run e2e"),
    },
    {
      name: "sleep after docker compose up -d",
      files: withServices(POSTGRES, "- run: docker compose up -d", "- run: sleep 20"),
    },
    {
      name: "computed options may contain a health check",
      files: withServices([...POSTGRES, "  options: ${{ matrix.pg-options }}"], "- run: sleep 15"),
    },
  ],
  invalid: [
    {
      name: "postgres without options and a fixed sleep",
      files: withServices(POSTGRES, "- run: sleep 15", "- run: npm test"),
      errors: [
        {
          line: 11,
          messageIncludes: "`sleep 15` waits a fixed 15s in job `test`, whose service container `postgres` (`postgres:16`) has no `--health-cmd`",
        },
      ],
    },
    {
      name: "options without a health check and a sleep in a script",
      files: withServices(
        ["redis:", "  image: redis:7", "  options: --tmpfs /data"],
        "- run: |",
        "    npm ci",
        "    sleep 1m",
        "    npm test",
      ),
      errors: [{ line: 12, messageIncludes: "`sleep 1m` waits a fixed 60s in job `test`, whose service container `redis` (`redis:7`)" }],
    },
    {
      name: "several services without health checks",
      files: withServices([...POSTGRES, "redis:", "  image: redis:7"], "- run: sleep 10"),
      errors: [{ line: 13, messageIncludes: "service containers `postgres` (`postgres:16`), `redis` (`redis:7`) have no `--health-cmd`" }],
    },
    {
      name: "custom threshold",
      options: { minSeconds: 2 },
      files: withServices(POSTGRES, "- run: sleep 3"),
      errors: [{ line: 11, messageIncludes: "waits a fixed 3s" }],
    },
  ],
});
