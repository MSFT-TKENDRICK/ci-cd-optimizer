import { describe, expect, it } from "vitest";
import rule, { cronMinutes } from "../../../../src/lint/rules/triggers/frequent-schedule.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const schedule = (cron: string) => yml("on:", "  schedule:", `    - cron: '${cron}'`, "jobs:", "  t:", "    runs-on: x");

describe("cronMinutes", () => {
  it.each([
    ["*", 60],
    ["*/5", 12],
    ["*/15", 4],
    ["0", 1],
    ["0,15,30,45", 4],
    ["0,10,20,30,40", 5],
    ["0-29/10", 3],
    ["5/20", 3],
  ])("%s matches %i minutes", (field, size) => {
    expect(cronMinutes(field)?.size).toBe(size);
  });

  it.each(["abc", "*/0", "70", "5-1", "1/2/3"])("rejects %s", (field) => {
    expect(cronMinutes(field)).toBeUndefined();
  });
});

ruleTester(rule, {
  valid: [
    { name: "every 15 minutes", files: schedule("*/15 * * * *") },
    { name: "hourly", files: schedule("0 * * * *") },
    { name: "four entries", files: schedule("0,15,30,45 * * * *") },
    { name: "unparseable", files: schedule("H * * * *") },
    { name: "custom threshold", files: schedule("*/10 * * * *"), options: { maxRunsPerHour: 6 } },
  ],
  invalid: [
    { files: schedule("*/5 * * * *"), errors: [{ line: 3, messageIncludes: "12 times an hour every hour" }] },
    { name: "every minute in office hours", files: schedule("* 9-17 * * 1-5"), errors: [{ messageIncludes: "60 times an hour during" }] },
    { name: "long list", files: schedule("0,10,20,30,40 * * * *"), errors: 1 },
    {
      name: "multiple schedules",
      files: yml("on:", "  schedule:", "    - cron: '*/5 * * * *'", "    - cron: '0 0 * * *'", "    - cron: '*/2 * * * *'", "jobs:", "  t:", "    runs-on: x"),
      errors: [{ line: 3 }, { line: 5 }],
    },
  ],
});
