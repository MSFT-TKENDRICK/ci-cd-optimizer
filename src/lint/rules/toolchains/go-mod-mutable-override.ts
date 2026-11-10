import type { ProjectModel } from "../../project.js";
import { basename } from "../caching/shared.js";
import { defineRule, type JobCommand } from "../helpers.js";
import { commandDirectory, effectiveEnv, envSource, findUp, jobContexts, toolCommands, withReplacedToken, words, type JobContext } from "./shared.js";

/** Module-aware commands that build or run code (and therefore resolve imports against go.mod). */
const BUILD_SUBCOMMANDS = new Set(["build", "test", "vet", "run", "install"]);
/** Jobs that change or inspect go.mod on purpose: tidy checks, dependency bumps, bots that commit the result. */
const MUTATING_JOB =
  /\bgit\s+(?:commit|push|diff|status)\b|\bgo\s+mod\s+(?:tidy|vendor|edit)\b|\bgo\s+get\b[^\n|;&]*\s-u\b|\bgo\s+work\b/;
const MUTATING_ACTIONS = [
  "peter-evans/create-pull-request",
  "stefanzweifel/git-auto-commit-action",
  "endbug/add-and-commit",
];
const GET_FLAGS = /^(?:-v|-t|-d|-x|-insecure)$/;
const LOCAL_PATTERN = /^(?:\.|\.\.?\/[^@\s]*|all)$/;
const VALUE_OPTIONS = new Set(["-mod", "--mod", "-modfile", "-overlay", "-tags", "-ldflags", "-gcflags", "-asmflags", "-gccgoflags", "-toolexec", "-p", "-o", "-C", "-coverpkg", "-run", "-bench", "-count", "-timeout", "-cpu", "-parallel"]);

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
  let args = separator < 0 ? rest : rest.slice(0, separator);
  const passthrough = args.indexOf("-args");
  if (passthrough >= 0) args = args.slice(0, passthrough);
  if (subcommand === "run") {
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index] ?? "";
      if (!word.startsWith("-")) {
        args = args.slice(0, index + 1);
        break;
      }
      if (VALUE_OPTIONS.has(word)) index += 1;
    }
  }
  return { subcommand, args };
}

/** The `-mod` value given on the command line (last one wins), or undefined. */
function modFlag(args: string[]): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    const match = /^--?mod(?:=(.*))?$/.exec(word);
    if (match) value = match[1] ?? args[index + 1];
    if (VALUE_OPTIONS.has(word)) index += 1;
  }
  return value;
}

/** GOFLAGS requires one flag per word; two-word values and unevaluated shell expressions are not settings. */
function goflagsMode(text: string): string | undefined {
  if (/['"$`\\]/.test(text)) return undefined;
  const flags = text.trim().split(/\s+/).filter(Boolean);
  if (flags.some((flag) => !/^--?[A-Za-z][\w-]*(?:=\S*)?$/.test(flag) || VALUE_OPTIONS.has(flag))) return undefined;
  return modFlag(flags);
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
  if (dir === undefined) return undefined;
  if (gowork !== "off") {
    if (gowork !== undefined && gowork !== "") return undefined;
    if (findUp(project, dir, "go.work")) {
      return undefined;
    }
  }
  return findUp(project, dir, "go.mod");
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
    if (goflagsMode(fromEnv.value) !== "mod") return undefined;
    return { path: fromEnv.path, line: fromEnv.line ?? command.line, text: fromEnv.value };
  }
  // The environment variable overrides the go env file, so `go env -w` only matters when GOFLAGS is not exported.
  let written: FlagSource | undefined;
  for (const other of ctx.commands) {
    if (other === command) break;
    const list = words(other.command);
    if (basename(list[0] ?? "") !== "go" || list[1] !== "env") continue;
    const target = list.slice(3).filter((word) => word.startsWith("GOFLAGS=")).at(-1);
    if ((list[2] === "-w" && target) || (list[2] === "-u" && list.includes("GOFLAGS"))) {
      const current = effectiveEnv(ctx, command, command);
      const previous = effectiveEnv(ctx, other, other);
      const unknown = ["GOENV", "HOME", "APPDATA", "XDG_CONFIG_HOME"].some((key) => current.get(key) !== previous.get(key));
      written = other.step.if || other.owner.if || current.get("GOENV") === "off" || unknown ||
        /\|\||(?:^|[\n;])\s*(?:if|then|elif|else|case|for|while|until)\b/.test(other.step.run?.value ?? "") ? undefined :
        list[2] === "-w" && target ? { path: other.path, line: other.line, text: target.slice("GOFLAGS=".length) } : undefined;
    }
  }
  return written !== undefined && goflagsMode(written.text) === "mod" ? written : undefined;
}

function mutatingJob(ctx: JobContext): boolean {
  return (
    ctx.commands.some(({ command }) => /^(?:git|go)\s/.test(words(command).join(" ")) && MUTATING_JOB.test(words(command).join(" "))) ||
    ctx.entries.some(({ step }) => step.uses !== undefined && MUTATING_ACTIONS.includes(step.uses.action.name ?? ""))
  );
}

function withoutModMod(raw: string, command: boolean): string {
  const list = words(raw);
  const args = command ? parseGo(list)?.args ?? [] : list;
  const offset = command ? 2 : 0;
  let replacement: { index: number; text: string } | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (/^--?mod=mod$/.test(word)) replacement = { index: offset + index, text: word.replace(/=mod$/, "=readonly") };
    else if (/^--?mod$/.test(word) && args[index + 1] === "mod") replacement = { index: offset + index + 1, text: "readonly" };
    if (VALUE_OPTIONS.has(word)) index += 1;
  }
  return replacement ? withReplacedToken(raw, replacement.index, replacement.text) ?? raw : raw;
}

export default defineRule({
  meta: {
    id: "toolchains/go-mod-mutable-override",
    ruleset: "toolchains",
    description: "CI should not let Go build commands rewrite go.mod and go.sum (`-mod=mod`, GOFLAGS, or a `go get` before building).",
    rationale:
      "In modern module-aware Go builds, -mod=mod permits go.mod updates when module loading needs them. Since Go 1.16 the ordinary default is readonly unless automatic vendor mode or other configuration applies. Readonly restricts go.mod updates, not every go.sum write; go mod download may also update sums. These flags do not prove an actual graph change or absence of review. If both files must remain unchanged, verify their diff after all resolving commands.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://go.dev/ref/mod#build-commands",
      "https://go.dev/ref/mod#go-mod-file-updates",
      "https://go.dev/ref/mod#resolve-pkg-mod",
      "https://pkg.go.dev/cmd/go#hdr-Environment_variables",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "env:\n  GOFLAGS: -mod=mod\nsteps:\n  - run: go test ./...",
      good: "steps:\n  - run: go test ./...  # -mod=readonly is the default since Go 1.16",
    },
  },
  check({ project, report }) {
    if (![...project.files.keys()].some((path) => basename(path) === "go.mod")) return;
    for (const ctx of jobContexts(project)) {
      const go = toolCommands(ctx, "go")
        .map(({ command, words: list }) => ({ command, parsed: parseGo(list) }))
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
            message: `\`${raw}\` runs before \`${build.command.command.trim()}\` and may add requirements/checksums to \`${module}\` and go.sum. That is a dependency-update operation, not just downloading an immutable graph; confirm it belongs in this build job.`,
            suggestion: `If only downloading is intended, compare omitting the step or using \`go mod download\`; either normal builds or download can still update go.sum. Where both files must stay unchanged, verify their diff after all resolving commands. Perform intentional dependency updates separately, review go.mod/go.sum, and test the resulting graph.`,
            related: [{ path: build.command.path, line: build.command.line }],
          });
          continue;
        }
        if (!isBuild(parsed)) continue;
        const module = moduleFile(project, ctx, command, parsed.args);
        if (module === undefined) continue;
        const flag = modFlag(parsed.args);
        if (flag === "mod") {
          report({
            path: command.path,
            line: command.line,
            key: `go-mod-flag:${command.path}:${command.line}`,
            message: `\`${raw}\` passes \`-mod=mod\`, permitting necessary updates to \`${module}\`. This does not establish that the graph changes. Readonly mode rejects required go.mod updates but can still write go.sum.`,
            suggestion: `If CI should reject required go.mod changes, test an explicit readonly policy:\n\n${withoutModMod(raw, true)}\n\nReview vendor/toolchain behavior before changing defaults. To enforce unchanged go.mod and go.sum, check their diff after all resolving commands; readonly alone is not that guarantee.`,
          });
          continue;
        }
        // A -mod flag on the command line overrides GOFLAGS.
        if (flag !== undefined) continue;
        const source = goflagsSource(project, ctx, command);
        if (source === undefined) continue;
        const elsewhere = source.path !== command.path || source.line !== command.line;
        report({
          path: source.path,
          line: source.line,
          key: `goflags:${source.path}:${source.line}`,
          message: `GOFLAGS is \`${source.text}\`, so \`${raw}\` may run with \`-mod=mod\` and update \`${module}\` if needed. That is permission, not an observed graph change; readonly still permits some go.sum writes.`,
          suggestion: `If CI should reject required go.mod changes, test \`GOFLAGS: ${withoutModMod(source.text, false)}\` with the intended vendor/toolchain policy. Separately check go.mod/go.sum after all resolving commands if both must remain unchanged.`,
          ...(elsewhere ? { related: [{ path: command.path, line: command.line }] } : {}),
        });
      }
    }
  },
});
