import { RULE_ASSURANCE } from "../formal/generated/rule-assurance.js";

export type RuleAssurance = typeof RULE_ASSURANCE.rules[number];
const entries = new Map<string, RuleAssurance>(RULE_ASSURANCE.rules.map((entry) => [entry.id, entry]));

/** Missing built-ins are errors, never silently assigned a default assurance label. */
export function ruleAssurance(id: string): RuleAssurance {
  const entry = entries.get(id);
  if (!entry) throw new Error(`Missing explicit assurance catalogue entry for built-in rule "${id}".`);
  return entry;
}

export function assuranceText(id: string): string {
  const entry = ruleAssurance(id);
  return `Detector: heuristic, not formally proved. Recommendation: conditional, not a universal improvement guarantee. Severity precedence: machine-proved.${entry.optionalModelCertificates.length ? " Optional cache-key certificates prove only the declared-dependency string-partition model." : ""}`;
}
