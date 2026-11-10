import type { ProjectModel } from "../../project.js";
import { defineRule } from "../helpers.js";
import { NIX_CONF_INPUTS, excludesUntrustedPr, flakeConfigTrust, nixJobs, untrustedPrTrigger, type FlakeConfigTrust } from "./shared.js";

function describe(decision: FlakeConfigTrust): string {
  const setting = decision.setting;
  switch (decision.via) {
    case "implicit":
      return "nixbuild/nix-quick-install-action appends `accept-flake-config = true` to nix.conf by default";
    case "cli":
      return `the command line sets \`${setting?.key ?? "accept-flake-config"} = ${setting?.value ?? "true"}\``;
    case "env":
      return `\`NIX_CONFIG\` sets \`accept-flake-config = ${setting?.value ?? "true"}\``;
    case "shell":
      return `a shell command writes \`accept-flake-config = ${setting?.value ?? "true"}\` to nix.conf`;
    default:
      return `the installer's nix.conf input sets \`accept-flake-config = ${setting?.value ?? "true"}\``;
  }
}

/** nix.conf lines that move the repository's own flake substituters into trusted configuration. */
function substituterLines(project: ProjectModel): string[] {
  const lines: string[] = [];
  for (const flake of project.nix.flakes) {
    for (const [key, entry] of flake.info?.nixConfig ?? []) {
      if (!/^(?:extra-)?(?:substituters|trusted-public-keys)$/.test(key) || entry.values.length === 0) continue;
      const name = key.startsWith("extra-") ? key : `extra-${key}`;
      const line = `${name} = ${entry.values.join(" ")}`;
      if (!lines.includes(line)) lines.push(line);
    }
  }
  return lines;
}

export default defineRule({
  meta: {
    id: "nix/accept-flake-config-untrusted",
    ruleset: "nix",
    description: "Nix accepts `nixConfig` from flakes that a pull request can modify.",
    rationale:
      "accept-flake-config allows eligible nixConfig settings from an evaluated flake without the usual confirmation. If a pull request controls that flake, it can influence settings such as substituters and trusted keys. Which settings take effect, and with what privilege, depends on Nix version, single-user versus daemon installation, trusted-user policy and CLI overrides; this detector does not establish root execution or cache compromise. Keep configuration policy outside untrusted flake content, especially when pull_request_target checks out the head or a persistent runner/cache is exposed. Disabling this setting alone does not make executing untrusted workflow code safe.",
    kind: "policy",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-accept-flake-config",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-format",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-trusted-users",
      "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "on: pull_request_target\n...\n- uses: actions/checkout@v5\n  with:\n    ref: ${{ github.event.pull_request.head.sha }}\n- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      accept-flake-config = true\n- run: nix flake check",
      good: "- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      accept-flake-config = false\n      extra-substituters = https://mycache.cachix.org\n      extra-trusted-public-keys = mycache.cachix.org-1:<key>\n- run: nix flake check",
    },
  },
  check({ project, report }) {
    const extraLines = substituterLines(project);
    for (const model of nixJobs(project)) {
      const { workflow, job } = model;
      const trigger = untrustedPrTrigger(project, workflow, job);
      if (!trigger || excludesUntrustedPr(job, trigger)) continue;
      for (const decision of flakeConfigTrust(model, (site) => !excludesUntrustedPr(site.step, trigger) && !excludesUntrustedPr(site.owner, trigger))) {
        const installer = model.installers.find((step) => NIX_CONF_INPUTS[step.uses?.action.name ?? ""]) ?? model.installers[0];
        const input = NIX_CONF_INPUTS[installer?.uses?.action.name ?? ""]?.[0] ?? "extra_nix_config";
        const confText = ["accept-flake-config = false", ...extraLines].map((line) => `      ${line}`).join("\n");
        const remedy =
          decision.via === "implicit"
            ? `nix-quick-install-action appends its own \`accept-flake-config = true\` after \`nix_conf\`, so override it through the environment, which takes precedence over nix.conf:\nenv:\n  NIX_CONFIG: accept-flake-config = false${extraLines.length > 0 ? `\nand add the flake's caches to the action's \`nix_conf\` input:\n  nix_conf: |\n${extraLines.map((line) => `    ${line}`).join("\n")}` : ""}`
            : decision.via === "cli"
              ? `Remove the flag and declare any caches the flake needs in the installer's trusted configuration:\n  with:\n    ${input}: |\n${confText}`
              : `Stop accepting flake configuration and declare the caches the flake needs in trusted configuration:\n  with:\n    ${input}: |\n${confText}`;
        const event = trigger === "pull_request_target" ? "`pull_request_target` job that checks out the pull request head" : "`pull_request` workflow";
        report({
          path: decision.path,
          line: decision.line,
          key: `${job.key}.accept-flake-config.${decision.path}:${decision.line}`,
          message: `In ${event} \`${job.id}\`, ${describe(decision)}. A pull-request-controlled flake can request eligible Nix settings without confirmation; actual effects depend on the installation, trusted-user policy and command overrides.`,
          suggestion: remedy,
          confidence: trigger === "pull_request_target" ? "high" : "medium",
        });
      }
    }
  },
});
