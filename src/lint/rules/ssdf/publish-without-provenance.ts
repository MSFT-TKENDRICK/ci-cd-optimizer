import { defineRule } from "../helpers.js";
import { hasProvenanceEvidence, publishSteps, stepLocation } from "./shared.js";

export default defineRule({
  meta: {
    id: "ssdf/publish-without-provenance",
    ruleset: "ssdf",
    description: "Published artifacts have no repository-visible integrity or provenance evidence.",
    rationale: "SSDF PS.2.1 and PS.3.1 call for integrity verification information and release supporting data. A workflow scan can observe common attestation steps, but cannot prove signature validity, artifact binding, retention, or evidence produced outside the workflow.",
    kind: "policy",
    defaultSeverity: "warn",
    presets: ["ssdf"],
    requires: ["repository"],
    defaultOptions: {},
    references: ["https://csrc.nist.gov/pubs/sp/800/218/final"],
    impact: "high",
    example: {
      bad: "steps:\n  - run: docker push ghcr.io/example/app:latest",
      good: "steps:\n  - uses: actions/attest-build-provenance@<full-commit-sha>\n    with:\n      subject-path: image.tar",
    },
  },
  check({ project, report }) {
    for (const entry of publishSteps(project)) {
      if (hasProvenanceEvidence(entry.job)) continue;
      report({
        ...stepLocation(entry),
        key: `${entry.workflow.path}:${entry.job.id}:provenance`,
        message: `This job publishes a ${entry.description} but contains no recognized provenance or integrity-evidence step. This is a repository-visible evidence gap, not proof that the artifact is unsigned.`,
        suggestion: "Attach verifiable provenance to the published artifact and make the verification information available to consumers; confirm the attestation is bound to the exact artifact and retained with the release.",
      });
    }
  },
});
