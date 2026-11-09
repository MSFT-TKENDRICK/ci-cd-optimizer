import { lineStart } from "../../fix.js";
import { runLine } from "../../parsers/workflow.js";
import { defineRule } from "../helpers.js";
import { fileOf } from "./docker.js";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);
const SCRIPT_INTERPRETERS = /^(python[\d.]*|perl|ruby|node)$/;
/** curl short options that take an argument (the rest of a combined flag group is that argument). */
const CURL_ARG_LETTERS = new Set([..."AbcCdDeEFHKmPQrTuUwxXyYz"]);
/** wget short options that take an argument. */
const WGET_ARG_LETTERS = new Set([..."aAbBDeiIlPQRtTUwXo"]);

/**
 * Verification of a downloaded file anywhere in the same step/RUN: checksum check modes, GPG/minisign/cosign
 * signatures, GitHub artifact attestations or SLSA provenance.
 */
const VERIFICATION = [
  /\b(?:sha(?:1|224|256|384|512)sum|b2sum|md5sum)\b[^\n;&|]*\s(?:-[a-zA-Z]*c[a-zA-Z]*|--check)\b/,
  /\bshasum\b[^\n;&|]*\s(?:-[a-zA-Z]*c[a-zA-Z]*|--check)\b/,
  /\bgpg2?\b[^\n;&|]*\s--verify\b/,
  /\bgpgv2?\b/,
  /\bcosign\s+verify(?:-blob|-attestation)?\b/,
  /\bminisign\b[^\n;&|]*\s-[a-zA-Z]*V/,
  /\bgh\s+attestation\s+verify\b/,
  /\bslsa-verifier\b/,
];

interface Finding {
  offset: number;
  command: string;
  url?: string;
  interpreter: string;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

function basename(word: string): string {
  return unquote(word).split("/").pop() ?? word;
}

/** Drops `sudo [-flags] [-u user]`, `env [VAR=x]`, `VAR=x`, `time`, `exec`, `command`, `!`, `{`, `(`, `then`, `do`. */
function stripWrappers(input: string[]): string[] {
  const list = [...input];
  for (;;) {
    const word = list[0];
    if (word === undefined) return list;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ["time", "exec", "command", "!", "{", "(", "then", "do", "else", "nohup"].includes(word)) {
      list.shift();
      continue;
    }
    if (basename(word) === "sudo" || basename(word) === "doas") {
      list.shift();
      while (list[0]?.startsWith("-")) {
        const flag = list.shift() ?? "";
        if (["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t", "--user", "--group"].includes(flag)) list.shift();
      }
      continue;
    }
    if (basename(word) === "env") {
      list.shift();
      while (list[0] !== undefined && (list[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0]))) list.shift();
      continue;
    }
    return list;
  }
}

/** Whether a curl/wget command writes the downloaded body to stdout (so it can be piped into an interpreter). */
function downloadsToStdout(args: string[]): "curl" | "wget" | undefined {
  const tool = basename(args[0] ?? "").replace(/^\\/, "");
  if (tool !== "curl" && tool !== "wget") return undefined;
  const toStdout = (value: string | undefined): boolean => value !== undefined && ["-", "/dev/stdout"].includes(unquote(value));
  let stdout = tool === "curl";
  for (let index = 1; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (word === "--") break;
    if (tool === "curl") {
      if (word === "--output" || word === "-o") {
        stdout = toStdout(args[index + 1]);
        index += 1;
      } else if (word.startsWith("--output=")) {
        stdout = toStdout(word.slice("--output=".length));
      } else if (word === "--remote-name" || word === "--remote-name-all" || word === "--output-dir") {
        if (word !== "--output-dir") stdout = false;
        else index += 1;
      } else if (/^-[A-Za-z#:]/.test(word) && !word.startsWith("--")) {
        const letters = word.slice(1);
        for (let at = 0; at < letters.length; at += 1) {
          const letter = letters[at] ?? "";
          if (letter === "O") {
            stdout = false;
          } else if (letter === "o") {
            const rest = letters.slice(at + 1);
            stdout = toStdout(rest === "" ? args[index + 1] : rest);
            if (rest === "") index += 1;
            break;
          } else if (CURL_ARG_LETTERS.has(letter)) {
            if (at === letters.length - 1) index += 1;
            break;
          }
        }
      }
    } else if (word === "--output-document" || word === "-O") {
      stdout = toStdout(args[index + 1]);
      index += 1;
    } else if (word.startsWith("--output-document=")) {
      stdout = toStdout(word.slice("--output-document=".length));
    } else if (/^-[A-Za-z]/.test(word) && !word.startsWith("--")) {
      const letters = word.slice(1);
      for (let at = 0; at < letters.length; at += 1) {
        const letter = letters[at] ?? "";
        if (letter === "O") {
          const rest = letters.slice(at + 1);
          stdout = toStdout(rest === "" ? args[index + 1] : rest);
          if (rest === "") index += 1;
          break;
        }
        if (WGET_ARG_LETTERS.has(letter)) {
          if (at === letters.length - 1) index += 1;
          break;
        }
      }
    }
  }
  return stdout ? tool : undefined;
}

/** The interpreter of a pipeline stage when it executes its stdin as a script (`sh`, `bash -s --`, `sudo -E bash -`). */
function stdinInterpreter(args: string[]): string | undefined {
  const name = basename(args[0] ?? "");
  if (SHELLS.has(name)) {
    for (let index = 1; index < args.length; index += 1) {
      const word = args[index] ?? "";
      if (word === "-" || word === "--") return args[index + 1] === undefined || word === "-" ? name : undefined;
      if (/^[-+]o$/.test(word) || word === "-O" || word === "--rcfile" || word === "--init-file") {
        index += 1;
        continue;
      }
      if (/^--/.test(word)) continue;
      if (/^[-+][A-Za-z]+$/.test(word)) {
        if (word.startsWith("-") && word.includes("s")) return name;
        if (word.startsWith("-") && word.includes("c")) return undefined;
        continue;
      }
      return undefined;
    }
    return name;
  }
  if (SCRIPT_INTERPRETERS.test(name)) {
    const rest = args.slice(1);
    return rest.length === 0 || rest[0] === "-" ? name : undefined;
  }
  return undefined;
}

/**
 * Splits text into commands (newlines, `;`, `&&`, `||`, `&`) and each command into pipeline stages (`|`, `|&`),
 * ignoring separators inside quotes, keeping offsets.
 */
function pipelines(text: string): Array<Array<{ text: string; offset: number }>> {
  const result: Array<Array<{ text: string; offset: number }>> = [];
  let stages: Array<{ text: string; offset: number }> = [];
  let stageStart = 0;
  let quote: string | undefined;
  const endStage = (end: number): void => {
    stages.push({ text: text.slice(stageStart, end), offset: stageStart });
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const previous = text[index - 1];
    if (char === "\n") quote = undefined;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    const double = (char === "&" && next === "&") || (char === "|" && next === "|");
    const background = char === "&" && previous !== ">" && previous !== "<" && previous !== "|" && next !== ">";
    if (char === "\n" || char === ";" || double || background) {
      endStage(index);
      result.push(stages);
      stages = [];
      if (double) index += 1;
      stageStart = index + 1;
      continue;
    }
    if (char === "|") {
      endStage(index);
      if (next === "&") index += 1;
      stageStart = index + 1;
    }
  }
  endStage(text.length);
  result.push(stages);
  return result;
}

function firstUrl(text: string): string | undefined {
  return /\bhttps?:\/\/[^\s"'`)|;]+/.exec(text)?.[0];
}

function leadingSpace(text: string): number {
  return text.length - text.trimStart().length;
}

/** Download-then-execute patterns in shell text whose continuations and comment lines are already blanked. */
function findings(text: string): Finding[] {
  const result: Finding[] = [];
  for (const stages of pipelines(text)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const stage = stages[index];
      if (!stage) continue;
      const args = stripWrappers(words(stage.text.replace(/^[\s({]*(?:\$\()?/, "")));
      if (!downloadsToStdout(args)) continue;
      const target = stages.slice(index + 1).find((later) => stdinInterpreter(stripWrappers(words(later.text))) !== undefined);
      if (!target) continue;
      const interpreter = stdinInterpreter(stripWrappers(words(target.text))) ?? "sh";
      const end = target.offset + target.text.trimEnd().length;
      const offset = stage.offset + leadingSpace(stage.text);
      const url = firstUrl(stage.text);
      result.push({ offset, command: text.slice(offset, end).replace(/\s+/g, " "), interpreter, ...(url ? { url } : {}) });
      break;
    }
  }
  const substitutions = [
    /(?:^|[\s;&|({!])(?:sudo\s+(?:-\S+\s+)*)?((?:\S*\/)?(?:bash|sh|zsh|ksh|dash)|source|\.)\s+(?:-\S+\s+)*<\(\s*(?:sudo\s+)?(?:curl|wget)\b[^)]*\)/g,
    /(?:^|[\s;&|({!])(?:sudo\s+(?:-\S+\s+)*)?((?:\S*\/)?(?:bash|sh|zsh|ksh|dash))\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b[^)`]*[)`]["']?/g,
    /(?:^|[\s;&|({!])(eval)\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b[^)`]*[)`]["']?/g,
  ];
  for (const pattern of substitutions) {
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const offset = match.index + leadingSpace(match[0].replace(/^[;&|({!]/, " "));
      const command = text.slice(offset, match.index + match[0].length).replace(/\s+/g, " ");
      const url = firstUrl(command);
      result.push({ offset, command, interpreter: basename(match[1] ?? "sh"), ...(url ? { url } : {}) });
    }
  }
  return result;
}

/** Blanks comment lines and joins backslash continuations without shifting offsets. */
function clean(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? " ".repeat(line.length) : line))
    .join("\n")
    .replace(/\\[ \t]*\r?\n/g, (match) => " ".repeat(match.length));
}

function verified(text: string): boolean {
  return VERIFICATION.some((pattern) => pattern.test(text));
}

function newlines(text: string): number {
  return text.match(/\n/g)?.length ?? 0;
}

function describe(finding: Finding): string {
  const source = finding.url ? `${finding.url.startsWith("http://") ? "over plain HTTP from " : "from "}\`${finding.url}\`` : "from the network";
  const command = finding.command.length > 120 ? `${finding.command.slice(0, 117)}...` : finding.command;
  return `\`${command}\` executes a script downloaded ${source} with \`${finding.interpreter}\` without verifying a checksum or signature`;
}

const SCORECARD = "OpenSSF Scorecard's Pinned-Dependencies check flags this as an unpinned `downloadThenRun` dependency.";

export default defineRule({
  meta: {
    id: "containers/curl-pipe-shell",
    ruleset: "containers",
    description: "A script is downloaded and executed in one go (`curl | sh`, `bash <(curl ...)`) without checksum or signature verification.",
    rationale:
      "Piping a download into an interpreter executes whatever the server returns at that moment: a compromised host, CDN or release, a moved tag, or a truncated transfer runs with the job's token and secrets, or is baked into the image. The content is never pinned, so two runs or two image builds of the same commit can execute different code. Downloading to a file, verifying a pinned checksum or signature, then executing makes the step hermetic and tamper-evident.",
    kind: "policy",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
      "https://docs.docker.com/reference/dockerfile/#verifying-a-remote-file-checksum-add---checksum",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "- run: curl -fsSL https://example.com/install.sh | sh",
      good: '- run: |\n    curl -fsSLo install.sh https://example.com/install.sh\n    echo "<sha256>  install.sh" | sha256sum -c -\n    sh install.sh',
    },
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (!step.run) continue;
          const shell = step.shell ?? job.shell ?? workflow.shell;
          if (shell && /^(pwsh|powershell|cmd|python)\b/i.test(shell.trim())) continue;
          const text = clean(step.run.value);
          if (verified(text)) continue;
          for (const finding of findings(text)) {
            const line = runLine(step, finding.offset);
            const url = finding.url ?? "<url>";
            report({
              path: workflow.path,
              line,
              key: `${step.key}:curl-pipe-shell:${line}:${finding.offset}`,
              message: `${describe(finding)}: the job runs whatever the server returns on that run, with its token and secrets. ${SCORECARD}`,
              suggestion: `Download to a file, verify a pinned checksum, then execute:\n  curl -fsSLo install.sh ${url}\n  echo "<sha256>  install.sh" | sha256sum -c -\n  ${finding.interpreter === "source" || finding.interpreter === "." || finding.interpreter === "eval" ? "sh" : finding.interpreter} install.sh`,
              impact: "high",
              confidence: "high",
            });
          }
        }
      }
    }
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      if (!file) continue;
      for (const instruction of model.instructions) {
        if (instruction.keyword !== "RUN") continue;
        const raw = file.content.slice(lineStart(file.content, instruction.line), lineStart(file.content, instruction.endLine + 1));
        const text = clean(raw.replace(/^(\s*)RUN\b(?:\s+--[a-z-]+(?:=\S*)?)*/i, (match) => " ".repeat(match.length)));
        if (verified(text)) continue;
        for (const finding of findings(text)) {
          const line = instruction.line + newlines(raw.slice(0, finding.offset));
          const url = finding.url ?? "<url>";
          report({
            path: model.path,
            line,
            key: `${model.path}:curl-pipe-shell:${line}:${finding.offset}`,
            message: `${describe(finding)}: the build bakes whatever the server returns into the image, so rebuilds of the same commit can differ or be tampered with. ${SCORECARD}`,
            suggestion: `Fetch the script with a pinned checksum, then run it:\n  ADD --checksum=sha256:<sha256> ${url} /tmp/install.sh\n  RUN sh /tmp/install.sh`,
            impact: "high",
            confidence: "high",
          });
        }
      }
    }
  },
});
