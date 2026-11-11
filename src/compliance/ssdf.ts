import { buildProject } from "../lint/project.js";
import { steps } from "../lint/rules/helpers.js";
import { hasProvenanceEvidence, hasSbomEvidence, publishSteps } from "../lint/rules/ssdf/shared.js";
import type { AnalysisInput, LintResult } from "../lint/types.js";

export type SsdfStatus = "evidence-observed" | "gap" | "unknown" | "requires-attestation";

export interface SsdfTask {
  id: string;
  title: string;
  status: SsdfStatus;
  evidence: string[];
}

export interface SsdfAssessment {
  standard: "NIST SP 800-218 SSDF v1.1";
  disclaimer: string;
  repository?: string;
  ref?: string;
  sha?: string;
  inventoryComplete: boolean;
  tasks: SsdfTask[];
  counts: Record<SsdfStatus, number>;
}

const TASKS: Array<[string, string]> = [
  ["PO.1.1", "Document and maintain infrastructure and process security requirements"],
  ["PO.1.2", "Document and maintain software security requirements"],
  ["PO.1.3", "Communicate security requirements to third-party component providers"],
  ["PO.2.1", "Define and periodically review secure-development roles"],
  ["PO.2.2", "Train personnel for secure-development responsibilities"],
  ["PO.2.3", "Obtain and communicate management commitment to secure development"],
  ["PO.3.1", "Define security tools and toolchain integration"],
  ["PO.3.2", "Securely deploy, operate, and maintain toolchains"],
  ["PO.3.3", "Configure tools to produce secure-development artifacts"],
  ["PO.4.1", "Define software security check criteria"],
  ["PO.4.2", "Gather and safeguard security-check information"],
  ["PO.5.1", "Separate and protect software-development environments"],
  ["PO.5.2", "Harden development endpoints using a risk-based approach"],
  ["PS.1.1", "Restrict access to code and configuration by least privilege"],
  ["PS.2.1", "Make software integrity verification information available"],
  ["PS.3.1", "Retain release artifacts and supporting integrity information"],
  ["PS.3.2", "Maintain provenance data for release components, such as SBOMs"],
  ["PW.1.1", "Use risk modeling to assess software security risk"],
  ["PW.1.2", "Track security requirements, risks, and design decisions"],
  ["PW.1.3", "Build in support for secure software development"],
  ["PW.2.1", "Ensure qualified security expertise is available"],
  ["PW.4.1", "Acquire and maintain well-secured software components"],
  ["PW.4.2", "Develop secure internal software components"],
  ["PW.4.4", "Verify third-party components against organization requirements"],
  ["PW.5.1", "Follow secure coding practices for the development environment"],
  ["PW.6.1", "Use build tools with executable-security features"],
  ["PW.6.2", "Configure and use approved build-tool security features"],
  ["PW.7.1", "Determine when code review and code analysis are required"],
  ["PW.7.2", "Review/analyze code and record and triage discovered issues"],
  ["PW.8.1", "Determine what executable-code testing is appropriate"],
  ["PW.8.2", "Perform, document, and triage executable-code testing"],
  ["PW.9.1", "Define a secure software-release configuration baseline"],
  ["PW.9.2", "Implement and document secure software defaults"],
  ["RV.1.1", "Collect and investigate vulnerability reports and intelligence"],
  ["RV.1.2", "Review, analyze, or test code for previously undetected vulnerabilities"],
  ["RV.1.3", "Publish and implement a vulnerability disclosure policy"],
  ["RV.2.1", "Assess vulnerability risk to plan an appropriate response"],
  ["RV.2.2", "Plan and implement vulnerability risk responses"],
  ["RV.3.1", "Analyze identified vulnerabilities for root causes"],
  ["RV.3.2", "Analyze root causes for recurring patterns"],
  ["RV.3.3", "Find and proactively fix similar vulnerabilities"],
  ["RV.3.4", "Update the SDLC to reduce recurrence of root causes"],
];

const REQUIRES_ATTESTATION = new Set([
  "PO.1.1", "PO.1.2", "PO.1.3", "PO.2.1", "PO.2.2", "PO.2.3", "PO.3.1", "PO.5.2",
  "PW.1.1", "PW.1.2", "PW.1.3", "PW.2.1", "PW.4.2", "PW.5.1", "PW.6.2", "PW.7.1",
  "PW.8.1", "PW.9.1", "PW.9.2", "RV.2.1", "RV.2.2", "RV.3.1", "RV.3.2", "RV.3.3", "RV.3.4",
]);

const RULE_TASKS: Record<string, string[]> = {
  "ssdf/publish-without-provenance": ["PS.2.1", "PS.3.1"],
  "ssdf/publish-without-sbom": ["PS.3.2"],
  "ssdf/attestation-missing-permissions": ["PS.2.1", "PS.3.1"],
  "ssdf/static-cloud-credentials": ["PO.5.1"],
};

const CODE_ANALYSIS_ACTIONS = new Set(["github/codeql-action/init", "github/codeql-action/analyze", "github/codeql-action/upload-sarif", "github/super-linter", "super-linter/super-linter"]);

const statusCounts = (tasks: SsdfTask[]): Record<SsdfStatus, number> => ({
  "evidence-observed": tasks.filter((task) => task.status === "evidence-observed").length,
  gap: tasks.filter((task) => task.status === "gap").length,
  unknown: tasks.filter((task) => task.status === "unknown").length,
  "requires-attestation": tasks.filter((task) => task.status === "requires-attestation").length,
});

export function assessSsdf(input: AnalysisInput, result: LintResult): SsdfAssessment {
  const filePaths = new Set(input.files.map((file) => file.path.toLowerCase()));
  const projectFiles = input.files;
  const project = buildProject(input);
  const diagnostics = new Map<string, string[]>();
  for (const diagnostic of result.diagnostics) {
    for (const task of RULE_TASKS[diagnostic.ruleId] ?? []) {
      const current = diagnostics.get(task) ?? [];
      current.push(`${diagnostic.path}:${diagnostic.line} - ${diagnostic.ruleId}: ${diagnostic.message}`);
      diagnostics.set(task, current);
    }
  }

  const observed = new Map<string, string[]>();
  const has = (pattern: RegExp) => projectFiles.some((file) => pattern.test(file.path));
  const add = (task: string, evidence: string) => observed.set(task, [...(observed.get(task) ?? []), evidence]);

  const securityPolicyPaths = projectFiles
    .filter((file) => ["security.md", ".github/security.md", "docs/security.md"].includes(file.path.toLowerCase()))
    .map((file) => file.path);
  if ([...filePaths].some((path) => ["codeowners", ".github/codeowners", "docs/codeowners"].includes(path))) {
    add("PS.1.1", "Repository contains a CODEOWNERS file; its coverage and enforcement are not verified.");
  }
  if (has(/^\.github\/dependabot\.ya?ml$/i) || has(/(^|\/)(renovate\.json5?|\.renovaterc(?:\.json5?)?)$/i)) {
    add("PW.4.1", "Repository contains a Dependabot or Renovate configuration; coverage and policy compliance are not verified.");
    add("RV.1.1", "Repository contains a dependency-update configuration; alert coverage and triage are not verified.");
  }
  const workflowSteps = [...steps(project.workflows)];
  if (workflowSteps.some(({ step }) => step.uses?.action?.name === "actions/dependency-review-action")) {
    add("PW.4.4", "A workflow references the dependency review action; its enforcement and results are not verified.");
  }
  if (workflowSteps.some(({ step }) => CODE_ANALYSIS_ACTIONS.has(step.uses?.action?.name ?? ""))) {
    add("RV.1.2", "A workflow references a code-analysis action; its coverage and findings are not verified.");
  }

  const allPublishJobs = publishSteps(project).map((entry) => entry.job);
  if (allPublishJobs.length > 0) {
    if (allPublishJobs.every(hasProvenanceEvidence)) {
      add("PS.2.1", "Every repository-visible publishing job has a recognized provenance or integrity-evidence step.");
      add("PS.3.1", "Every repository-visible publishing job has a recognized provenance or integrity-evidence step.");
    }
    if (allPublishJobs.every(hasSbomEvidence)) {
      add("PS.3.2", "Every repository-visible publishing job has a recognized SBOM-generation step.");
    }
  }

  const tasks = TASKS.map(([id, title]) => {
    const failures = diagnostics.get(id) ?? [];
    if (failures.length > 0) return { id, title, status: "gap" as const, evidence: failures };
    if (REQUIRES_ATTESTATION.has(id)) {
      return { id, title, status: "requires-attestation" as const, evidence: ["This organizational/process control cannot be established from repository files alone."] };
    }
    const evidence = observed.get(id);
    if (evidence?.length) return { id, title, status: "evidence-observed" as const, evidence };
    if (id === "RV.1.3" && securityPolicyPaths.length > 0) {
      return {
        id, title, status: "unknown" as const,
        evidence: [`Found ${securityPolicyPaths.join(", ")}; path presence does not establish a vulnerability-disclosure policy. Its contents and operation have not been assessed.`],
      };
    }
    const reason = input.inventoryComplete
      ? "No supported repository-visible evidence was found; absence does not establish noncompliance."
      : "Repository inventory is incomplete, so absence cannot be assessed.";
    return { id, title, status: "unknown" as const, evidence: [reason] };
  });

  return {
    standard: "NIST SP 800-218 SSDF v1.1",
    disclaimer: "This is repository evidence reporting, not a compliance determination or attestation. Evidence observed does not establish that a control is effective; unknown means this scan could not assess the task.",
    inventoryComplete: input.inventoryComplete,
    tasks,
    counts: statusCounts(tasks),
  };
}

export function renderSsdfMarkdown(assessment: SsdfAssessment): string {
  const counts = assessment.counts;
  const cell = (value: string) => value.replace(/\s+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "&#96;").replaceAll("|", "\\|");
  const rows = assessment.tasks.map((task) => `| ${task.id} | ${cell(task.title)} | ${task.status} | ${cell(task.evidence.join(" "))} |`);
  return [
    `# ${assessment.standard} repository evidence`,
    "",
    assessment.disclaimer,
    "",
    ...(assessment.repository ? [`Repository: **${assessment.repository}**${assessment.ref ? ` at \`${assessment.ref}\`` : ""}${assessment.sha ? ` (\`${assessment.sha}\`)` : ""}.`, ""] : []),
    `Inventory complete: **${assessment.inventoryComplete ? "yes" : "no"}**.`,
    `Tasks: **${assessment.tasks.length}**; evidence observed: **${counts["evidence-observed"]}**; gaps: **${counts.gap}**; unknown: **${counts.unknown}**; requires attestation: **${counts["requires-attestation"]}**.`,
    "",
    "| SSDF task | Topic | Status | Evidence / limitation |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
