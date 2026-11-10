import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULE_ASSURANCE } from "../../src/formal/generated/rule-assurance.js";
import { ruleAssurance } from "../../src/lint/assurance.js";
import { allRules } from "../../src/lint/rules/index.js";

describe("complete per-rule assurance catalogue", () => {
  it("has exactly one explicit, current entry for every built-in", () => {
    expect(RULE_ASSURANCE.rules.map((entry) => entry.id).sort()).toEqual(allRules.map((rule) => rule.meta.id).sort());
    for (const { meta } of allRules) {
      const entry = ruleAssurance(meta.id);
      expect(entry.metadataSha256).toBe(createHash("sha256").update(JSON.stringify(meta)).digest("hex"));
      expect(entry.detector.assurance).toBe("heuristic-not-formally-proved");
      expect(entry.recommendation.assurance).toBe("conditional-not-universally-proved");
      expect(entry.engineContracts).toEqual(["severity-last-assignment-wins"]);
      if (meta.id !== "caching/cache-key") expect(entry.optionalModelCertificates).toEqual([]);
    }
    expect(() => ruleAssurance("new/missing-rule")).toThrow(/Missing explicit/);
  });

  it("ships the identical machine-readable inventory without silently assigning proof labels", () => {
    const json: unknown = JSON.parse(readFileSync(new URL("../../formal/rule-assurance.json", import.meta.url), "utf8"));
    expect(json).toEqual(RULE_ASSURANCE);
    expect(RULE_ASSURANCE.engineContract.exclusions).toContain("detector correctness");
    expect(RULE_ASSURANCE.engineContract.exclusions).toContain("pipeline performance");
  });
});
