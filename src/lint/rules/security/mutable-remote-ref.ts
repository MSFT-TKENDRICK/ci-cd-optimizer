import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule, steps } from "../helpers.js";

const SHA = /^[0-9a-f]{40}$/i;
const VERSION_TAG = /^v?\d+(?:\.\d+){1,2}(?:[-+][\w.-]+)?$/;
const MUTABLE_GO = new Set(["latest", "master", "main", "HEAD", "head", "upgrade", "patch"]);

function isImmutableRef(ref: string | undefined): boolean {
  return ref !== undefined && (SHA.test(ref) || VERSION_TAG.test(ref));
}

function stripQuotes(word: string): string {
  return word.replace(/^["']|["']$/g, "");
}

function pipIssue(words: string[]): string | undefined {
  const installAt = words.findIndex((word) => word === "install");
  const tool = words[0] ?? "";
  const isPip = /^pip3?$/.test(tool) || (/^python3?$/.test(tool) && words[1] === "-m" && /^pip3?$/.test(words[2] ?? ""));
  const isUv = tool === "uv" && words[1] === "pip";
  if (!(isPip || isUv) || installAt < 0) return undefined;
  for (const raw of words.slice(installAt + 1)) {
    const word = stripQuotes(raw);
    const spec = /(?:^|@\s*)git\+[a-z]+:\/\/(\S+)$/i.exec(word)?.[1] ?? /^git\+(\S+)$/i.exec(word)?.[1];
    if (spec === undefined) continue;
    const path = spec.split("#")[0] ?? "";
    const ref = /@([^@/]+)$/.exec(path.replace(/^[^/]*@/, ""))?.[1];
    if (!isImmutableRef(ref)) return `\`${word}\` installs ${ref === undefined ? "the default branch" : `\`${ref}\``} of a git repository`;
  }
  return undefined;
}

function nodeIssue(words: string[]): string | undefined {
  const [tool, sub] = words;
  if (!tool || !["npm", "yarn", "pnpm"].includes(tool)) return undefined;
  if (!sub || !["install", "i", "add"].includes(sub)) return undefined;
  for (const raw of words.slice(2)) {
    const word = stripQuotes(raw);
    if (!/^(?:github:|git\+|git:\/\/)/i.test(word)) continue;
    const ref = word.includes("#") ? word.slice(word.indexOf("#") + 1) : undefined;
    if (ref !== undefined && (ref.startsWith("semver:") || isImmutableRef(ref))) continue;
    return `\`${word}\` installs ${ref === undefined ? "the default branch" : `\`${ref}\``} of a git repository`;
  }
  return undefined;
}

function goIssue(words: string[]): string | undefined {
  if (words[0] !== "go" || words[1] !== "install") return undefined;
  for (const raw of words.slice(2)) {
    const word = stripQuotes(raw);
    const ref = /@([^@]+)$/.exec(word)?.[1];
    if (ref !== undefined && MUTABLE_GO.has(ref)) return `\`${word}\` resolves a moving version`;
  }
  return undefined;
}

function cargoIssue(words: string[]): string | undefined {
  if (words[0] !== "cargo" || words[1] !== "install") return undefined;
  const git = words.findIndex((word) => word === "--git" || word.startsWith("--git="));
  if (git < 0) return undefined;
  const pinned = words.some((word) => /^--(?:rev|tag)(?:=|$)/.test(word));
  if (pinned) return undefined;
  const url = words[git]?.startsWith("--git=") ? words[git]?.slice(6) : words[git + 1];
  return `\`cargo install --git ${url ?? ""}\` builds whatever the branch points at`;
}

export default defineRule({
  meta: {
    id: "security/mutable-remote-ref",
    ruleset: "security",
    description:
      "Tools installed straight from a git repository or `@latest` should be pinned to a commit SHA or release version.",
    rationale:
      "Installing from a branch (or a repository's default branch) runs whatever code that branch holds at the moment the job starts. A force-push, a compromised maintainer account, or a hijacked repository silently changes what CI executes, and the run cannot be reproduced later. Pinning to a full commit SHA or a released version makes the dependency immutable and reviewable.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
      "https://pip.pypa.io/en/stable/topics/vcs-support/",
      "https://docs.npmjs.com/cli/configuring-npm/package-json#git-urls-as-dependencies",
      "https://go.dev/ref/mod#go-install",
      "https://doc.rust-lang.org/cargo/commands/cargo-install.html",
    ],
    impact: "medium",
    example: {
      bad: "- run: pip install git+https://github.com/example/tool.git@main",
      good: "- run: pip install git+https://github.com/example/tool.git@3f1c2b9e8d7a6f5e4d3c2b1a09f8e7d6c5b4a392",
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps(project.workflows)) {
      for (const { command, line } of commandsOf(step)) {
        const words = commandWords(command);
        const issue = pipIssue(words) ?? nodeIssue(words) ?? goIssue(words) ?? cargoIssue(words);
        if (!issue) continue;
        report({
          path: workflow.path,
          line,
          key: `${step.key}.run`,
          message: `${issue}, so the code CI runs can change without any change to this repository.`,
          suggestion: "Pin the install to a full commit SHA (or a released version) instead of a branch or `latest`.",
        });
      }
    }
  },
});
