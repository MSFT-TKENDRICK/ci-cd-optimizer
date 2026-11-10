import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { allRules } from "../src/lint/rules/index.js";

const command = process.argv[2];
if (command !== "generate" && command !== "check") throw new Error("Usage: tsx scripts/assurance.ts generate|check");
const rules = [...allRules].sort((a, b) => a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0);
if (new Set(rules.map((rule) => rule.meta.id)).size !== rules.length) throw new Error("Duplicate built-in rule id.");
const catalogue = {
  schema: "cicd-optimizer/rule-assurance-v1",
  interpretation: "This exhaustive claim inventory is not a proof of detector correctness or recommendation benefits. Only the separately scoped engine/model contracts are machine-proved.",
  engineContract: {
    id: "severity-last-assignment-wins", theorem: "Policy.Resolve",
    implementation: "src/lint/config.ts -> src/formal/policy.ts -> generated Policy.Resolve",
    guarantee: "The last present assignment wins (matching preset defaults, then ruleset override, then explicit rule override); no assignment means off.",
    exclusions: ["YAML parsing", "preset membership extraction", "option merging", "capability/suppression handling", "detector correctness", "autofix semantics", "pipeline performance"],
  },
  rules: rules.map(({ meta }) => ({
    id: meta.id,
    metadataSha256: createHash("sha256").update(JSON.stringify(meta)).digest("hex"),
    detector: { assurance: "heuristic-not-formally-proved", claim: meta.description },
    recommendation: { assurance: "conditional-not-universally-proved", rationale: meta.rationale },
    autofix: meta.fixable ? "not-formally-proved" : "not-provided",
    engineContracts: ["severity-last-assignment-wins"],
    optionalModelCertificates: meta.id === "caching/cache-key" ? ["cache-primary-key-partition-relative-to-declared-D"] : [],
  })),
};
const json = `${JSON.stringify(catalogue, null, 2)}\n`;
const generated = `// GENERATED: npm run assurance:generate; explicit entries are checked against the complete built-in registry.\nexport const RULE_ASSURANCE = ${json.trimEnd()} as const;\n`;
for (const [path, content] of [["formal/rule-assurance.json", json], ["src/formal/generated/rule-assurance.ts", generated]]) {
  if (!path || content === undefined) throw new Error("Invalid assurance output.");
  if (command === "generate") await writeFile(path, content);
  else if ((await readFile(path, "utf8")).replaceAll("\r\n", "\n") !== content) throw new Error(`${path} is stale; review rule claims, then run npm run assurance:generate.`);
}
console.log(`Checked explicit assurance entries for all ${rules.length} built-in rules; detector/recommendation proofs are not claimed.`);
