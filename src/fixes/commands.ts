export type FixCommand =
  | { type: "rebase" }
  | { type: "recreate" }
  | { type: "close" }
  | { type: "ignore-group" }
  | { type: "ignore-rule"; rule?: string };

const MENTION = /^\s*@(?:ci-?cd-optimizer)(?:\[bot\])?\s+(.+?)\s*$/gim;

/**
 * Parses Dependabot-style comment commands, one per line:
 * `@cicd-optimizer rebase|recreate|close|ignore this group|ignore this rule [rule-id]`.
 */
export function parseCommands(body: string | null | undefined): FixCommand[] {
  const commands: FixCommand[] = [];
  for (const match of (body ?? "").matchAll(MENTION)) {
    const text = (match[1] ?? "").toLowerCase().replace(/\s+/g, " ");
    if (text === "rebase") commands.push({ type: "rebase" });
    else if (text === "recreate") commands.push({ type: "recreate" });
    else if (text === "close") commands.push({ type: "close" });
    else if (text === "ignore this group") commands.push({ type: "ignore-group" });
    else {
      const rule = /^ignore this rule(?: ([a-z0-9-]+\/[a-z0-9-]+))?$/.exec(text);
      if (rule) commands.push(rule[1] ? { type: "ignore-rule", rule: rule[1] } : { type: "ignore-rule" });
    }
  }
  return commands;
}

export const COMMAND_HELP = [
  "<details>",
  "<summary>Commands</summary>",
  "",
  "You can trigger actions by commenting on this pull request:",
  "- `@cicd-optimizer rebase` rebuilds the fixes on the latest base branch (unless someone else pushed to it)",
  "- `@cicd-optimizer recreate` rebuilds the fixes, overwriting any edits made to this pull request",
  "- `@cicd-optimizer close` closes this pull request; it is not reopened for the same change",
  "- `@cicd-optimizer ignore this rule <rule-id>` stops proposing fixes for that rule (all rules in this pull request when omitted)",
  "- `@cicd-optimizer ignore this group` closes this pull request and stops proposing fixes for this group",
  "",
  "Ignores are remembered through the `cicd-optimizer:ignored` label; remove it from the pull request to undo. Use `fixes.ignore` in `.github/ci-cd-optimizer.yml` for permanent configuration.",
  "</details>",
].join("\n");
