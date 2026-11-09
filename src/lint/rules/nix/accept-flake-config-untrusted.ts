import { fix, replaceOnLine } from "../../fix.js";
import type { ProjectModel } from "../../project.js";
import { defineRule } from "../helpers.js";
import { NIX_CONF_INPUTS, excludesUntrustedPr, flakeConfigTrust, nixJobs, untrustedPrTrigger, type FlakeConfigTrust } from "./shared.js";

/** Flake `nixConfig` keys whose loss only costs cache hits or cosmetics when flake configuration stops being accepted. */
const DROPPABLE_KEYS = new Set([
  "substituters",
  "extra-substituters",
  "trusted-public-keys",
  "extra-trusted-public-keys",
  "bash-prompt",
  "bash-prompt-prefix",
  "bash-prompt-suffix",
  "flake-registry",
  "commit-lock-file-summary",
]);

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
      "A flake's `nixConfig` attribute can set arbitrary nix.conf settings. Nix ignores it (apart from prompt and registry cosmetics) unless `accept-flake-config` is true; with it, and with the runner user listed in `trusted-users` as the Nix installers configure it, the settings reach the root-owned nix-daemon. A pull request that edits flake.nix can then add its own `extra-substituters` and `extra-trusted-public-keys` so that the store paths it builds or tests are served pre-built by an attacker's cache, set `sandbox = false` so derivations read the runner's environment and network, or add a `post-build-hook` that the daemon runs as root. Under `pull_request_target` (secrets, write token, and the base repository's cache scope) this turns \"build the PR in the sandbox\" into code execution with the workflow's privileges and lets poisoned paths flow into the binary cache the job pushes to; under `pull_request` the same applies on self-hosted runners with a persistent store and to any cache the job writes.",
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
    fixable: true,
    example: {
      bad: "on: pull_request_target\n...\n- uses: actions/checkout@v5\n  with:\n    ref: ${{ github.event.pull_request.head.sha }}\n- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      accept-flake-config = true\n- run: nix flake check",
      good: "- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      accept-flake-config = false\n      extra-substituters = https://mycache.cachix.org\n      extra-trusted-public-keys = mycache.cachix.org-1:<key>\n- run: nix flake check",
    },
  },
  check({ project, report }) {
    const extraLines = substituterLines(project);
    const droppable = project.nix.flakes.every((flake) => [...(flake.info?.nixConfig.keys() ?? [])].every((key) => DROPPABLE_KEYS.has(key)));
    for (const model of nixJobs(project)) {
      const { workflow, job } = model;
      const trigger = untrustedPrTrigger(project, workflow, job);
      if (!trigger || excludesUntrustedPr(job, trigger)) continue;
      for (const decision of flakeConfigTrust(model)) {
        const installer = model.installers.find((step) => NIX_CONF_INPUTS[step.uses?.action.name ?? ""]) ?? model.installers[0];
        const input = NIX_CONF_INPUTS[installer?.uses?.action.name ?? ""]?.[0] ?? "extra_nix_config";
        const confText = ["accept-flake-config = false", ...extraLines].map((line) => `      ${line}`).join("\n");
        const remedy =
          decision.via === "implicit"
            ? `nix-quick-install-action appends its own \`accept-flake-config = true\` after \`nix_conf\`, so override it through the environment, which takes precedence over nix.conf:\nenv:\n  NIX_CONFIG: accept-flake-config = false${extraLines.length > 0 ? `\nand add the flake's caches to the action's \`nix_conf\` input:\n  nix_conf: |\n${extraLines.map((line) => `    ${line}`).join("\n")}` : ""}`
            : decision.via === "cli"
              ? `Remove the flag and declare any caches the flake needs in the installer's trusted configuration:\n  with:\n    ${input}: |\n${confText}`
              : `Stop accepting flake configuration and declare the caches the flake needs in trusted configuration:\n  with:\n    ${input}: |\n${confText}`;
        const file = project.files.get(decision.path);
        const repair =
          decision.via === "installer" && droppable && file
            ? fix("Set accept-flake-config = false", replaceOnLine(file, decision.line, /(?<=\baccept-flake-config\s*=\s*)\S+/, "false"))
            : undefined;
        const event = trigger === "pull_request_target" ? "`pull_request_target` job that checks out the pull request head" : "`pull_request` workflow";
        report({
          path: decision.path,
          line: decision.line,
          key: `${job.key}.accept-flake-config.${decision.path}:${decision.line}`,
          message: `In ${event} \`${job.id}\`, ${describe(decision)}, so a pull request can set nix.conf options (substituters, trusted keys, \`sandbox\`, \`post-build-hook\`) through flake.nix \`nixConfig\` and have the nix-daemon apply them.`,
          suggestion: remedy,
          confidence: trigger === "pull_request_target" ? "high" : "medium",
          ...(repair ? { fix: repair } : {}),
        });
      }
    }
  },
});
