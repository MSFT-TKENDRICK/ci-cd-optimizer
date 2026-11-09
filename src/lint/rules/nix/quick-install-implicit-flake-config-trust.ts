import { fix, indentOf, insertLinesAfter, lineText } from "../../fix.js";
import type { SourceFile } from "../../types.js";
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

/** True when a job-level key `key` exists under the job starting at `jobLine` whose children are indented by `indent`. */
function jobHasKey(content: string, jobLine: number, indent: string, key: string): boolean {
  const lines = content.split(/\r?\n/);
  for (let index = jobLine; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (/^\s*(?:#.*)?$/.test(text)) continue;
    const own = /^\s*/.exec(text)?.[0] ?? "";
    if (own.length < indent.length) return false;
    if (own.length === indent.length && new RegExp(`^\\s*["']?${key}["']?\\s*:`).test(text)) return true;
  }
  return false;
}

/** Adds `env: NIX_CONFIG: accept-flake-config = false` to the job when nothing else in the job sets `NIX_CONFIG`. */
function addJobEnv(model: NixJob, file: SourceFile | undefined) {
  const { workflow, job } = model;
  if (!file || Object.keys(job.env).length > 0 || workflow.env.NIX_CONFIG !== undefined) return undefined;
  if (job.steps.some((step) => step.env.NIX_CONFIG !== undefined) || model.commands.some((entry) => entry.command.includes("NIX_CONFIG"))) return undefined;
  const header = lineText(file.content, job.line);
  if (!/^\s*["']?[\w-]+["']?\s*:\s*(?:#.*)?$/.test(header)) return undefined;
  const indent = indentOf(file.content, job.line + 1);
  if (indent.length <= indentOf(file.content, job.line).length) return undefined;
  if (jobHasKey(file.content, job.line, indent, "env")) return undefined;
  return fix(
    "Override accept-flake-config through job-level NIX_CONFIG",
    insertLinesAfter(file, job.line, [`${indent}env:`, `${indent}  NIX_CONFIG: accept-flake-config = false`]),
  );
}

export default defineRule({
  meta: {
    id: "nix/quick-install-implicit-flake-config-trust",
    ruleset: "nix",
    description: "nixbuild/nix-quick-install-action silently enables `accept-flake-config`.",
    rationale:
      "Since v25, nix-quick-install-action writes its `nix_conf` input to the user's nix.conf and then appends `accept-flake-config = true` whenever the installed Nix is newer than 2.13. Every `nix` command in the job therefore applies the `nixConfig` attribute of the top-level flake it evaluates without the interactive confirmation Nix normally requires: extra substituters and trusted public keys, `sandbox`, `post-build-hook`, and any other nix.conf option. For `nix run github:owner/tool` that hands nix.conf to a third party; for the repository's own flake it makes the effective Nix configuration depend on flake.nix instead of the workflow. Because nix.conf honours the last assignment, `accept-flake-config = false` inside `nix_conf` is overridden by the appended line. `NIX_CONFIG` is applied after the configuration files, so setting it in the job environment restores Nix's default.",
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
    fixable: true,
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
        const file = project.files.get(workflow.path);
        const repair = addJobEnv(model, file);
        report({
          path: decision.path,
          line: decision.line,
          key: `${job.key}.quick-install-flake-config`,
          message: `\`${action}\` appends \`accept-flake-config = true\` to nix.conf, so Nix commands in job \`${job.id}\` apply the \`nixConfig\` of ${remote ? `\`${remote}\` and any other flake they evaluate` : "any flake they evaluate"} (substituters, trusted keys, \`sandbox\`, \`post-build-hook\`) without confirmation.${ignored ? " The `accept-flake-config = false` in `nix_conf` has no effect: the action appends its own line after it and the last assignment wins." : ""}`,
          suggestion: `Override it through the environment, which Nix applies after nix.conf:\n    env:\n      NIX_CONFIG: accept-flake-config = false\nand list any caches the repository's flake needs in the action's \`nix_conf\` input as \`extra-substituters\` / \`extra-trusted-public-keys\`.`,
          confidence: "high",
          ...(repair ? { fix: repair } : {}),
        });
      }
    }
  },
});
