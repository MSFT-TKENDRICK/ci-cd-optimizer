import { parseArgs } from "node:util";
import { allRules } from "../lint/rules/index.js";
import type { LintConfig } from "../lint/config.js";
import { lint as runLint } from "../lint/engine.js";
import { loadDirectory } from "../lint/inventory.js";
import type { AnalysisInput } from "../lint/types.js";
import { assessSsdf, renderSsdfMarkdown } from "../compliance/ssdf.js";
import { defaultBranch, loadRemoteConfig, loadRepositorySnapshot } from "../github/repository.js";
import { UsageError, githubClient, repoFrom, resolvePath, writeText, type CliIO } from "./io.js";
import { loadLintConfig } from "./lint.js";

export const SSDF_HELP = `Usage: ci-cd-optimizer ssdf [options]

Reports repository-visible evidence against NIST SP 800-218 SSDF v1.1. This is not a compliance determination.
Controls requiring organizational, operational, or external evidence remain unknown or require attestation.

Options:
      --root <dir>          Local repository root (default: current directory)
      --repo <owner/name>   Report a remote repository instead of the local checkout
      --ref <ref>           Branch or commit for --repo (default: its default branch)
  -f, --format text|json    Output format (default: text)
  -o, --output <file>       Write the report to a file
  -h, --help                Show this help
`;

export async function ssdfCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      root: { type: "string" },
      repo: { type: "string" },
      ref: { type: "string" },
      format: { type: "string", short: "f", default: "text" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(SSDF_HELP);
    return 0;
  }
  if (values.format !== "text" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}". Use text or json.`);

  let config: LintConfig;
  let input: AnalysisInput;
  let source: { repository: string; ref: string; sha?: string } | undefined;
  if (values.repo) {
    if (values.root) throw new UsageError("--root cannot be combined with --repo.");
    const repo = repoFrom(values.repo, io);
    const client = githubClient(io);
    const ref = values.ref ?? await defaultBranch(client, repo);
    const remoteConfig = await loadRemoteConfig(client, repo, ref);
    if (remoteConfig.problems.length > 0) {
      throw new UsageError(`Invalid configuration ${remoteConfig.path ?? ".github/ci-cd-optimizer.yml"}: ${remoteConfig.problems.map((problem) => `${problem.path || "(root)"}: ${problem.message}`).join("; ")}`);
    }
    config = remoteConfig.config;
    const snapshot = await loadRepositorySnapshot(client, repo, { ref, config });
    input = snapshot.input;
    source = { repository: `${repo.owner}/${repo.repo}`, ref: snapshot.ref, sha: snapshot.sha };
  } else {
    if (values.ref) throw new UsageError("--ref requires --repo.");
    const root = resolvePath(io, values.root ?? ".");
    const loaded = await loadLintConfig(io, root, undefined);
    config = loaded.config;
    input = await loadDirectory(root, config);
  }
  config.extends = [...new Set([...config.extends, "ssdf" as const])];
  const result = runLint(input, { config, rules: allRules });
  const report = { ...assessSsdf(input, result), ...source };
  const output = values.format === "json" ? JSON.stringify(report, null, 2) : renderSsdfMarkdown(report);
  await writeText(io, values.output, output);
  return 0;
}
