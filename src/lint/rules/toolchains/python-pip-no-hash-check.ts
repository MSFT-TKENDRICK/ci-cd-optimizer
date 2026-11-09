import type { ProjectModel } from "../../project.js";
import { basename } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { commandDirectory, effectiveEnv, jobContexts, joinPath, words } from "./shared.js";

const PIP = /^pip(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i;
const PYTHON = /^(?:python(?:\d+(?:\.\d+)?)?|py)(?:\.exe)?$/i;
/** pip general options that take a value (they may appear before the subcommand). */
const GENERAL_VALUE_OPTIONS = new Set([
  "--python",
  "--log",
  "--keyring-provider",
  "--proxy",
  "--retries",
  "--timeout",
  "--exists-action",
  "--trusted-host",
  "--cert",
  "--client-cert",
  "--cache-dir",
  "--use-feature",
  "--use-deprecated",
  "--resume-retries",
]);
/** `pip install` options that take a value; requirement and constraint inputs are handled separately. */
const INSTALL_VALUE_OPTIONS = new Set([
  ...GENERAL_VALUE_OPTIONS,
  "-t",
  "--target",
  "--platform",
  "--python-version",
  "--implementation",
  "--abi",
  "--root",
  "--prefix",
  "--src",
  "--upgrade-strategy",
  "-C",
  "--config-settings",
  "--global-option",
  "--no-binary",
  "--only-binary",
  "--progress-bar",
  "--root-user-action",
  "--report",
  "-i",
  "--index-url",
  "--extra-index-url",
  "-f",
  "--find-links",
  "--group",
  "--build-constraint",
]);
/** Requirements-file options that do not change how requirements are pinned or hashed. */
const NEUTRAL_FILE_OPTIONS =
  /^(?:-i|--index-url|--extra-index-url|--no-index|-f|--find-links|--no-binary|--only-binary|--prefer-binary|--pre|--trusted-host|--use-feature)(?:[=\s]|$)/;
/** `name[extras]==version ; marker`, pinned to one exact version. */
const PINNED = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\s*\[[^\]]*\])?\s*===?\s*[A-Za-z0-9][A-Za-z0-9.+!_-]*\s*(?:;.*)?$/;

interface PipInstall {
  /** Requirement files as written on the command line. */
  requirements: string[];
}

/** Arguments after `pip [general options]`, when the command is `pip …`, `pipX.Y …` or `python -m pip …`. */
function pipArgs(list: string[]): string[] | undefined {
  const first = list[0];
  if (first === undefined) return undefined;
  const tool = basename(first.replace(/\\/g, "/"));
  if (PIP.test(tool)) return list.slice(1);
  if (!PYTHON.test(tool)) return undefined;
  let index = 1;
  // Interpreter flags such as `-u`, and the Windows launcher's version selector (`py -3.12`).
  while (/^-(?:[bBdEiIOqsSuvx]+|\d+(?:\.\d+)?)$/.test(list[index] ?? "")) index += 1;
  return list[index] === "-m" && list[index + 1] === "pip" ? list.slice(index + 2) : undefined;
}

/** `pip install -r <file> …` with nothing but requirement files and neutral options; undefined otherwise. */
function parsePipInstall(list: string[]): PipInstall | undefined {
  const args = pipArgs(list);
  if (args === undefined || list.some((word) => /[$`*]/.test(word))) return undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (!word.startsWith("-")) break;
    if (GENERAL_VALUE_OPTIONS.has(word)) index += 1;
  }
  if (args[index] !== "install") return undefined;
  const requirements: string[] = [];
  const rest = args.slice(index + 1);
  for (let position = 0; position < rest.length; position += 1) {
    const word = rest[position] ?? "";
    let file: string | undefined;
    if (word === "-r" || word === "--requirement") {
      position += 1;
      file = rest[position];
      if (file === undefined) return undefined;
    } else file = /^--requirement=(.+)$/.exec(word)?.[1] ?? /^-r(.+)$/.exec(word)?.[1];
    if (file !== undefined) {
      requirements.push(file);
      continue;
    }
    // Hash checking already forced or deliberately relaxed, or inputs this rule cannot see through.
    if (/^(?:--require-hashes|--no-require-hashes|-c|--constraint|-e|--editable)(?:=|$)/.test(word) || /^-[ce]./.test(word)) {
      return undefined;
    }
    if (INSTALL_VALUE_OPTIONS.has(word)) {
      position += 1;
      continue;
    }
    // A positional package (`.`, `pkg`, a wheel) would also need a hash in hash-checking mode.
    if (!word.startsWith("-")) return undefined;
  }
  return requirements.length > 0 ? { requirements } : undefined;
}

/** Number of requirements when every one of them is pinned with `==`/`===` and none is hashed; undefined otherwise. */
function pinnedWithoutHashes(content: string): number | undefined {
  let count = 0;
  const joined = content.replace(/\\\r?\n/g, " ");
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/(?:^|\s)#.*$/, "").trim();
    if (line === "") continue;
    if (/--hash\b|--require-hashes\b|\$\{/.test(line)) return undefined;
    if (line.startsWith("-")) {
      if (NEUTRAL_FILE_OPTIONS.test(line)) continue;
      return undefined;
    }
    if (!PINNED.test(line)) return undefined;
    count += 1;
  }
  return count > 0 ? count : undefined;
}

function requirementFiles(project: ProjectModel, dir: string, written: string[]): Array<{ path: string; count: number }> | undefined {
  const result: Array<{ path: string; count: number }> = [];
  for (const file of written) {
    const path = joinPath(dir, file);
    const content = path === undefined ? undefined : project.files.get(path)?.content;
    const count = content === undefined ? undefined : pinnedWithoutHashes(content);
    if (path === undefined || count === undefined) return undefined;
    result.push({ path, count });
  }
  return result;
}

export default defineRule({
  meta: {
    id: "toolchains/python-pip-no-hash-check",
    ruleset: "toolchains",
    description: "CI installs fully pinned requirements files with pip without hash-checking mode (`--hash` entries and `--require-hashes`).",
    rationale:
      "Pinning with `==` fixes which version pip installs, not which file: pip downloads whatever distribution the configured index, mirror or proxy serves for that version and only checks it against the hash in the download URL, which comes from the same server and therefore does not detect tampering. In hash-checking mode pip compares every downloaded archive with sha256 hashes committed in the requirements file and refuses anything else, so a CI install becomes reproducible down to the artifact. The mode is all-or-nothing: every requirement and every transitive dependency needs a pin and a hash, which is why the file should be generated by a lock tool.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://pip.pypa.io/en/stable/topics/secure-installs/#hash-checking-mode",
      "https://pip.pypa.io/en/stable/topics/secure-installs/#forcing-hash-checking-mode",
      "https://docs.astral.sh/uv/reference/cli/#uv-pip-compile--generate-hashes",
    ],
    impact: "low",
    fixable: false,
    example: {
      bad: "# requirements.txt\nrequests==2.32.3\n# workflow\n- run: pip install -r requirements.txt",
      good: "# requirements.txt (generated with --generate-hashes)\nrequests==2.32.3 \\\n    --hash=sha256:<hash>\n# workflow\n- run: pip install --require-hashes -r requirements.txt",
    },
  },
  check({ project, report }) {
    for (const ctx of jobContexts(project)) {
      for (const command of ctx.commands) {
        const parsed = parsePipInstall(words(command.command));
        if (!parsed) continue;
        const env = effectiveEnv(ctx, command, command);
        // Hash checking may be configured outside the command (environment or a pip configuration file).
        if (env.has("PIP_REQUIRE_HASHES") || env.has("PIP_CONFIG_FILE")) continue;
        const dir = commandDirectory(ctx, command);
        const files = dir === undefined ? undefined : requirementFiles(project, dir, parsed.requirements);
        if (files === undefined) continue;
        const raw = command.command.trim();
        const names = files.map(({ path }) => `\`${path}\``).join(", ");
        const total = files.reduce((sum, { count }) => sum + count, 0);
        const first = files[0]?.path ?? "requirements.txt";
        const install = raw.replace(/\binstall\b/, "install --require-hashes");
        report({
          path: command.path,
          line: command.line,
          key: `pip-hashes:${command.path}:${command.line}`,
          message: `\`${raw}\` installs ${total} requirement${total === 1 ? "" : "s"} pinned with \`==\` from ${names} without hash-checking mode: the pins fix versions, but pip accepts whatever archive the index or a mirror serves for them, so a tampered or substituted artifact is not detected.`,
          suggestion: `Generate the file with sha256 hashes for every requirement and transitive dependency (hash-checking mode rejects anything unhashed), for example from your direct dependencies in requirements.in:\n\nuv pip compile requirements.in --generate-hashes -o ${first}\n\nThen force hash checking in CI so a missing hash fails instead of silently disabling the check:\n\n${install}`,
          related: files.map(({ path }) => ({ path, line: 1 })),
        });
      }
    }
  },
});
