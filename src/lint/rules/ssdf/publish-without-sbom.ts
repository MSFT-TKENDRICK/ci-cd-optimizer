import { defineRule } from "../helpers.js";
import { publishSteps, hasSbomEvidence, stepLocation } from "./shared.js";

export default defineRule({
  meta: {
    id: "ssdf/publish-without-sbom",
    ruleset: "ssdf",
    description: "Published artifacts have no repository-visible software bill of materials generation.",
    rationale: "SSDF PS.3.2 recommends maintaining provenance data for release components, such as an SBOM. A repository scan cannot observe registry-side or external inventory generation, so this finding is limited to workflow-visible evidence.",
    kind: "policy",
    defaultSeverity: "info",
    presets: ["ssdf"],
    requires: ["repository"],
    defaultOptions: {},
    references: ["https://csrc.nist.gov/pubs/sp/800/218/final"],
    impact: "medium",
    example: {
      bad: "steps:\n  - run: docker push ghcr.io/example/app:latest",
      good: "steps:\n  - uses: anchore/sbom-action@<full-commit-sha>\n  - uses: actions/attest-sbom@<full-commit-sha>",
    },
  },
  check({ project, report }) {
    for (const entry of publishSteps(project)) {
      if (hasSbomEvidence(entry.job)) continue;
      report({
        ...stepLocation(entry),
        key: `${entry.workflow.path}:${entry.job.id}:sbom`,
        message: `This job publishes a ${entry.description} but contains no recognized SBOM generation step. Registry-side or external inventory may exist and is not visible to this rule.`,
        suggestion: "Generate an SBOM for the exact artifact and retain or publish it alongside the release; consider attesting the SBOM.",
      });
    }
  },
});
