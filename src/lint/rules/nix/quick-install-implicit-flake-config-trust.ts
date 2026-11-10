import { defineRule } from "../helpers.js";
import {
  confValues,
  excludesUntrustedPr,
  flakeConfigTrust,
  installerConf,
  isFalsyConf,
  nixJobs,
  untrustedPrTrigger,
  type NixJob,
} from "./shared.js";

const REMOTE_FLAKE = /^(?:github|gitlab|sourcehut|git\+[a-z]+|hg\+[a-z]+|https?|tarball\+https?|file\+https?):/i;

/** The first remote flake reference a Nix command in the job evaluates, e.g. `github:owner/tool`. */
function remoteFlake(model: NixJob): string | undefined {
  for (const entry of model.commands) {
    const ref = entry.nix?.args.find((arg) => REMOTE_FLAKE.test(arg));
    if (ref) return ref;
  }
  return undefined;
}

export default defineRule({
  meta: {
    id: "nix/quick-install-implicit-flake-config-trust",
    ruleset: "nix",
    description: "nixbuild/nix-quick-install-action silently enables `accept-flake-config`.",
    rationale:
      "The recognized nix-quick-install-action releases append accept-flake-config = true after nix_conf when installing Nix newer than 2.13 (including 2.13.6). Flake-evaluating commands can then accept eligible top-level nixConfig settings without confirmation. This is a single-user installer, not evidence that a root-owned daemon honors every option. A false setting inside nix_conf is overwritten by the appended line; an effective NIX_CONFIG or CLI setting can override it. Review trust deliberately and preserve existing configuration when changing it. Unknown releases, dynamic versions and opaque configuration writes are not treated as established trust.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/nixbuild/nix-quick-install-action/blob/v30/nix-quick-install.sh",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-accept-flake-config",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-format",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: nixbuild/nix-quick-install-action@v30\n        with:\n          nix_conf: accept-flake-config = false\n      - run: nix run github:owner/tool",
      good: "jobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      NIX_CONFIG: accept-flake-config = false\n    steps:\n      - uses: nixbuild/nix-quick-install-action@v30\n      - run: nix run github:owner/tool",
    },
  },
  check({ project, report }) {
    for (const model of nixJobs(project)) {
      const { workflow, job } = model;
      const trigger = untrustedPrTrigger(project, workflow, job);
      if (trigger && !excludesUntrustedPr(job, trigger)) continue;
      for (const decision of flakeConfigTrust(model)) {
        if (decision.via !== "implicit" || !decision.step) continue;
        const action = `nixbuild/nix-quick-install-action@${decision.step.uses?.action.ref ?? ""}`;
        const ignored = confValues(installerConf(decision.step, workflow.path), "accept-flake-config").some((setting) => isFalsyConf(setting.value));
        const remote = remoteFlake(model);
        report({
          path: decision.path,
          line: decision.line,
          key: `${job.key}.quick-install-flake-config`,
          message: `\`${action}\` appends \`accept-flake-config = true\` to nix.conf, and a flake-evaluating command in job \`${job.id}\` has no recognized later override. It can accept eligible \`nixConfig\` settings without confirmation.${remote ? ` This job also references remote flake \`${remote}\`.` : ""}${ignored ? " The false setting in nix_conf is followed by the action's true setting; last assignment wins." : ""}`,
          suggestion: `If automatic flake configuration is not intended, merge \`accept-flake-config = false\` into the effective NIX_CONFIG for the affected commands, preserving existing entries and checking step/CLI overrides. Declare only independently reviewed substituters and keys in trusted configuration. This can change behavior and requires validation.`,
          confidence: "high",
        });
      }
    }
  },
});
