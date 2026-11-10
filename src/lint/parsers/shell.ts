/** A lexical shell view, not an interpreter. Opaque or incomplete syntax is left unanalyzed. */
export interface ShellToken {
  value: string;
  raw: string;
}

export function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let value = "";
  let start = -1;
  let quote: string | undefined;
  const flush = (end: number): void => {
    if (start >= 0) tokens.push({ value, raw: command.slice(start, end) });
    value = "";
    start = -1;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (char === "\\" && quote !== "'" && (command.charAt(index + 1) === "\n" || command.slice(index + 1, index + 3) === "\r\n")) {
      index += command.charAt(index + 1) === "\r" ? 2 : 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && /[$`"\\]/.test(command.charAt(index + 1))) {
        value += command.charAt(++index);
      } else value += char;
      continue;
    }
    if (command.startsWith("${{", index)) {
      const close = command.indexOf("}}", index + 3);
      if (close < 0) return [];
      if (start < 0) start = index;
      value += command.slice(index, close + 2);
      index = close + 1;
      continue;
    }
    if (char === "`" || command.startsWith("$(", index) || command.startsWith("<(", index) || command.startsWith(">(", index)) return [];
    if (/\s/.test(char)) {
      flush(index);
      continue;
    }
    if ("|<>&;".includes(char) || (char === "#" && start < 0)) {
      if ((char === ">" || char === "<") && start >= 0 && /^\d+$/.test(command.slice(start, index))) start = -1;
      flush(index);
      break;
    }
    if (start < 0) start = index;
    if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && index + 1 < command.length) value += command.charAt(++index);
    else value += char;
  }
  if (quote) return [];
  flush(command.length);
  return tokens;
}

const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t", "--user", "--group", "--host", "--chdir"]),
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  nice: new Set(["-n", "--adjustment"]),
  exec: new Set(["-a"]),
  command: new Set(),
  nohup: new Set(),
};

/** Removes leading assignments and known command wrappers without confusing option values for the executable. */
export function commandTokens(command: string): ShellToken[] {
  const tokens = shellTokens(command);
  let index = 0;
  while (index < tokens.length) {
    const word = tokens[index]?.value ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1;
    else if (Object.hasOwn(WRAPPERS, word)) {
      const values = WRAPPERS[word];
      index += 1;
      while ((tokens[index]?.value ?? "").startsWith("-")) {
        const option = tokens[index]?.value ?? "";
        if (option === "--help" || option === "--version" || (word === "command" && /^-[p]*[vV]/.test(option)) ||
            (word === "sudo" && /^(?:-[^-]*[vVlK]|--list|--validate)/.test(option))) return [];
        index += values?.has(option) ? 2 : 1;
        if (option === "--") break;
      }
    } else break;
  }
  return tokens.slice(index);
}

export function shellWords(command: string): string[] {
  return commandTokens(command).map((token) => token.value);
}

function withoutContinuations(text: string): string {
  let result = "";
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\" && quote !== "'") {
      if (text.charAt(index + 1) === "\n" || text.slice(index + 1, index + 3) === "\r\n") {
        index += text.charAt(index + 1) === "\r" ? 2 : 1;
        continue;
      }
      result += char + text.charAt(++index);
      continue;
    }
    if (quote === char) quote = undefined;
    else if (!quote && ["'", '"', "`"].includes(char)) quote = char;
    result += char;
  }
  return result;
}

/** Commands separated outside quotes, substitutions and heredoc bodies, with original source offsets. */
export function splitShellCommands(script: string): Array<{ command: string; offset: number }> {
  // Definitions can shadow tool names, and their bodies do not execute at declaration time.
  if (/(?:^|[\n;])\s*(?:(?:function\s+[\w-]+(?:\s*\(\s*\))?|[\w-]+\s*\(\s*\))\s*\{|(?:alias|unalias)\s)/.test(script)) return [];
  const result: Array<{ command: string; offset: number }> = [];
  let start = 0;
  let quote: string | undefined;
  let depth = 0;
  let heredocs: Array<{ delimiter: string; tabs: boolean }> = [];
  const emit = (end: number): void => {
    const raw = script.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const command = withoutContinuations(raw.trim());
    if (command) result.push({ command, offset: start + leading });
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (char === "\\" && quote !== "'") {
      index += script[index + 1] === "\r" && script[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (script.startsWith("${{", index)) {
      const close = script.indexOf("}}", index + 3);
      if (close < 0) return [];
      index = close + 1;
      continue;
    }
    if (char === "#"
      && (index === start || /\s/.test(script[index - 1] ?? ""))) {
      if (depth === 0) emit(index);
      const newline = script.indexOf("\n", index);
      if (newline < 0) return result;
      index = newline - 1;
      if (depth === 0) start = newline;
      continue;
    }
    if (script.startsWith("<<", index) && script[index + 2] !== "<") {
      const match = /^<<(-)?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(script.slice(index));
      if (!match?.[3]) return [];
      heredocs.push({ delimiter: match[3], tabs: Boolean(match[1]) });
      index += match[0].length - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return [];
      depth -= 1;
    }
    if (depth > 0) continue;
    const pair = script.slice(index, index + 2);
    if (char !== "\n" && char !== ";" && pair !== "&&" && pair !== "||") continue;
    emit(index);
    if (pair === "&&" || pair === "||") index += 1;
    start = index + 1;
    if (char === "\n" && heredocs.length > 0) {
      for (const { delimiter, tabs } of heredocs) {
        let found = false;
        while (start < script.length) {
          const end = script.indexOf("\n", start);
          const raw = script.slice(start, end < 0 ? script.length : end).replace(/\r$/, "");
          start = end < 0 ? script.length : end + 1;
          if ((tabs ? raw.replace(/^\t+/, "") : raw) === delimiter) {
            found = true;
            break;
          }
        }
        if (!found) return result;
      }
      heredocs = [];
      index = start - 1;
    }
  }
  if (!quote && depth === 0 && heredocs.length === 0) emit(script.length);
  return result;
}
