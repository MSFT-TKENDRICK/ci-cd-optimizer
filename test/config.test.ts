import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("parses supported configuration and defaults invalid values", () => {
    const config = parseConfig({
      path: ".github/ci-cd-optimizer.yml",
      size: 100,
      content: `
enabled: true
failOnSeverity: high
disabledRules:
  - workflow-timeout
ignoredPaths:
  - generated/**
maxFiles: 200
`,
    });

    expect(config.failOnSeverity).toBe("high");
    expect(config.disabledRules).toEqual(["workflow-timeout"]);
    expect(config.ignoredPaths).toEqual(["generated/**"]);
    expect(config.maxFiles).toBe(200);
  });
});
