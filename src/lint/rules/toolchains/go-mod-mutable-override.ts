import { fix, lineStart, lineText } from "../../fix.js";
import type { ProjectModel } from "../../project.js";
import type { TextEdit } from "../../types.js";
import { basename } from "../caching/shared.js";
import { defineRule, type JobCommand } from "../helpers.js";
import { commandDirectory, effectiveEnv, envSource, findUp, findUpFrom, jobContexts, words, type JobContext } from "./shared.js";

/** Module-aware commands that build or run code (and therefore resolve imports against go.mod). */
const BUILD_SUBCOMMANDS = new Set(["build", "test", "vet", "run", "install"]);
/** `-mod=mod` / `--mod=mod` as one GOFLAGS entry or command-line word. */
const MOD_MOD_ENTRY = /(?:^|[\s"'])--?mod=mod(?=$|[\s"'])/;
/** The same flag as written on a line, including the two-word `-mod mod` form. */
const MOD_MOD_TEXT = /(?<![\w-])(--?mod)([= ])mod(?![\w.=/-])/g;
/** Jobs that change or inspect go.mod on purpose: tidy checks, dependency bumps, bots that commit the result. */
const MUTATING_JOB =
  /\bgit\s+(?:commit|push|diff|status)\b|\bgo\s+mod\s+(?:tidy|vendor|edit)\b|\bgo\s+get\b[^\n|;&]*\s-u\b|\bgo\s+work\b/;
const MUTATING_ACTIONS = [
  "peter-evans/create-pull-request",
  "stefanzweifel/git-auto-commit-action",
  "endbug/add-and-commit",
];
const GO_ENV_WRITE = /\bgo\s+env\s+-w\s+(?:[^\n]*\s)?GOFLAGS=("[^"]*"|'[^']*'|\S*)/;
const GO_ENV_UNSET = /\bgo\s+env\s+-u\s+(?:[^\n]*\s)?GOFLAGS\b/;
const GET_FLAGS = /^(?:-v|-t|-d|-x|-insecure)$/;
const LOCAL_PATTERN = /^(?:\.|\.\.?\/[^@\s]*|all)$/;

interface GoCommand {
  subcommand: string;
  args: string[];
}

function parseGo(list: string[]): GoCommand | undefined {
  if (list[0] === undefined || basename(list[0]) !== "go" || list.some((word) => /[$`]/.test(word))) return undefined;
  const subcommand = list[1];
  if (subcommand === undefined) return undefined;
  const rest = list.slice(2);
  const separator = rest.indexOf("--");
  return { subcommand, args: separator < 0 ? rest : rest.slice(0, separator) };
}

/** The `-mod` value given on the command line (last one wins), or undefined. */
function modFlag(args: string[]): string | undefined {
  let value: string | undefined;
  args.forEach((word, index) => {
    const match = /^--?mod(?:=(.*))?$/.exec(word);
    if (match) value = match[1] ?? args[index + 1];
  });
  return value;
}

function isBuild(parsed: GoCommand | undefined): parsed is GoCommand {
  // `go install pkg@version` / `go run pkg@version` ignore the main module, so -mod does not apply to them.
  return parsed !== undefined && BUILD_SUBCOMMANDS.has(parsed.subcommand) && !parsed.args.some((word) => word.includes("@"));
}

/** The go.mod a command resolves against; undefined outside module mode or in workspace mode (prefer silence). */
function moduleFile(project: ProjectModel, ctx: JobContext, command: JobCommand, args: string[]): string | undefined {
  const env = effectiveEnv(ctx, command, command);
  if (env.get("GO111MODULE") === "off") return undefined;
  const gowork = env.get("GOWORK");
  const changesDir = args.some((word) => word === "-C" || word.startsWith("-C="));
  const dir = changesDir ? undefined : commandDirectory(ctx, command);
  if (gowork !== "off") {
    if (gowork !== undefined && gowork !== "") return undefined;
    if (dir === undefined ? [...project.files.keys()].some((path) => basename(path) === "go.work") : findUp(project, dir, "go.work")) {
      return undefined;
    }
  }
  return findUpFrom(project, dir, "go.mod", "go.mod");
}

/** Replaces the single `-mod=mod` on a line with `-mod=readonly`; undefined when the line has none or several. */
function readonlyEdit(project: ProjectModel, path: string, line: number): TextEdit | undefined {
  const file = project.files.get(path);
  if (!file) return undefined;
  const text = lineText(file.content, line);
  const matches = [...text.matchAll(MOD_MOD_TEXT)];
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) return undefined;
  const start = lineStart(file.content, line) + match.index;
  return { path, start, end: start + match[0].length, text: `${match[1] ?? "-mod"}${match[2] ?? "="}readonly` };
}

interface FlagSource {
  path: string;
  line: number;
  text: string;
}

/** Where `GOFLAGS` (with `-mod=mod`) comes from for a command: the environment, or an earlier `go env -w`. */
function goflagsSource(project: ProjectModel, ctx: JobContext, command: JobCommand): FlagSource | undefined {
  const fromEnv = envSource(project, ctx, command, "GOFLAGS");
  if (fromEnv !== undefined) {
    if (!MOD_MOD_ENTRY.test(fromEnv.value)) return undefined;
    return { path: fromEnv.path, line: fromEnv.line ?? command.line, text: fromEnv.value };
  }
  // The environment variable overrides the go env file, so `go env -w` only matters when GOFLAGS is not exported.
  let written: FlagSource | undefined;
  for (const other of ctx.commands) {
    if (other === command) break;
    const set = GO_ENV_WRITE.exec(other.command);
    if (set) written = { path: other.path, line: other.line, text: (set[1] ?? "").replace(/^(["'])(.*)\1$/, "$2") };
    else if (GO_ENV_UNSET.test(other.command)) written = undefined;
  }
  return written !== undefined && MOD_MOD_ENTRY.test(written.text) ? written : undefined;
}

function mutatingJob(ctx: JobContext): boolean {
  return (
    ctx.commands.some(({ command }) => MUTATING_JOB.test(command)) ||
    ctx.entries.some(({ step }) => step.uses !== undefined && MUTATING_ACTIONS.includes(step.uses.action.name ?? ""))
  );
}

function withoutModMod(raw: string): string {
  return raw.replace(MOD_MOD_TEXT, (_match, flag: string, separator: string) => `${flag}${separator}readonly`);
}

export default defineRule({
  meta: {
    id: "toolchains/go-mod-mutable-override",
    ruleset: "toolchains",
    description: "CI should not let Go build commands rewrite go.mod and go.sum (`-mod=mod`, GOFLAGS, or a `go get` before building).",
    rationale:
      "Since Go 1.16, build commands (`go build`, `go test`, `go vet`, ...) act as if `-mod=readonly` were set: when go.mod is missing a requirement or go.sum lacks a checksum they fail with an error instead of changing the files. `-mod=mod` (on the command line or through GOFLAGS) and `go get` turn that off: the go command looks up modules for missing imports, picks whatever version the proxy serves at that moment and updates go.mod and go.sum on the runner. CI then passes with a dependency graph that is not committed and that nobody reviewed, and an untidy go.mod is never caught.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://go.dev/ref/mod#build-commands",
      "https://go.dev/ref/mod#go-mod-file-updates",
      "https://go.dev/ref/mod#resolve-pkg-mod",
      "https://pkg.go.dev/cmd/go#hdr-Environment_variables",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "env:\n  GOFLAGS: -mod=mod\nsteps:\n  - run: go test ./...",
      good: "steps:\n  - run: go test ./...  # -mod=readonly is the default since Go 1.16",
    },
  },
  check({ project, report }) {
    if (![...project.files.keys()].some((path) => basename(path) === "go.mod")) return;
    for (const ctx of jobContexts(project)) {
      const go = ctx.commands
        .map((command) => ({ command, parsed: parseGo(words(command.command)) }))
        .filter((entry): entry is { command: JobCommand; parsed: GoCommand } => entry.parsed !== undefined);
      if (!go.some(({ parsed }) => isBuild(parsed)) || mutatingJob(ctx)) continue;
      for (const [position, { command, parsed }] of go.entries()) {
        const raw = command.command.trim();
        if (parsed.subcommand === "get") {
          const flags = parsed.args.filter((word) => word.startsWith("-"));
          const targets = parsed.args.filter((word) => !word.startsWith("-"));
          if (!flags.every((flag) => GET_FLAGS.test(flag)) || !targets.every((target) => LOCAL_PATTERN.test(target))) continue;
          const build = go.slice(position + 1).find((later) => isBuild(later.parsed));
          const module = moduleFile(project, ctx, command, parsed.args);
          if (build === undefined || module === undefined) continue;
          report({
            path: command.path,
            line: command.line,
            key: `go-get:${command.path}:${command.line}`,
            message: `\`${raw}\` runs before \`${build.command.command.trim()}\` and lets the go command add missing requirements and checksums to \`${module}\` and go.sum on the runner, so the build uses a dependency graph that is not committed and an untidy go.mod never fails CI (build commands default to -mod=readonly since Go 1.16).`,
            suggestion: `Download the committed module graph without changing it:\n\ngo mod download\n\n(or drop the step: go build and go test download what they need). Fix missing requirements locally with \`go mod tidy\` and commit go.mod and go.sum. In module mode \`go get\` only manages dependencies; its -d flag is deprecated and always on since Go 1.18. To install a tool, use \`go install example.com/tool@v1.2.3\`, which does not touch go.mod.`,
            related: [{ path: build.command.path, line: build.command.line }],
          });
          continue;
        }
        if (!isBuild(parsed)) continue;
        const module = moduleFile(project, ctx, command, parsed.args);
        if (module === undefined) continue;
        const flag = modFlag(parsed.args);
        if (flag === "mod") {
          const repair = fix("Replace -mod=mod with -mod=readonly", readonlyEdit(project, command.path, command.line));
          report({
            path: command.path,
            line: command.line,
            key: `go-mod-flag:${command.path}:${command.line}`,
            message: `\`${raw}\` passes \`-mod=mod\`, which lets the go command add missing requirements and rewrite \`${module}\` and go.sum on the runner instead of failing (the default since Go 1.16 is -mod=readonly), so CI builds a dependency graph that is not committed.`,
            suggestion: `Drop the override, or make it explicit:\n\n${withoutModMod(raw)}\n\nThen fix missing requirements locally with \`go mod tidy\` and commit go.mod and go.sum. Like -mod=mod, -mod=readonly ignores the vendor directory, so module loading is otherwise unchanged.`,
            ...(repair ? { fix: repair } : {}),
          });
          continue;
        }
        // A -mod flag on the command line overrides GOFLAGS.
        if (flag !== undefined) continue;
        const source = goflagsSource(project, ctx, command);
        if (source === undefined) continue;
        const elsewhere = source.path !== command.path || source.line !== command.line;
        const repair = fix("Replace -mod=mod with -mod=readonly in GOFLAGS", readonlyEdit(project, source.path, source.line));
        report({
          path: source.path,
          line: source.line,
          key: `goflags:${source.path}:${source.line}`,
          message: `GOFLAGS is \`${source.text}\`, so \`${raw}\` runs with \`-mod=mod\` and may add missing requirements and rewrite \`${module}\` and go.sum on the runner instead of failing (the default since Go 1.16 is -mod=readonly); CI then builds a dependency graph that is not committed.`,
          suggestion: `Remove \`-mod=mod\` from GOFLAGS, or make the safe default explicit:\n\nGOFLAGS: ${withoutModMod(source.text)}\n\nThen fix missing requirements locally with \`go mod tidy\` and commit go.mod and go.sum.`,
          ...(elsewhere ? { related: [{ path: command.path, line: command.line }] } : {}),
          ...(repair ? { fix: repair } : {}),
        });
      }
    }
  },
});
