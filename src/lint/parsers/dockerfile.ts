export interface DockerInstruction {
  keyword: string;
  args: string;
  flags: Map<string, string[]>;
  line: number;
  endLine: number;
}

export interface DockerStage {
  index: number;
  name?: string;
  image: string;
  tag?: string;
  digest?: string;
  line: number;
  instructions: DockerInstruction[];
}

export interface DockerfileModel {
  path: string;
  dir: string;
  instructions: DockerInstruction[];
  stages: DockerStage[];
  /** ARG values declared before the first FROM, used to resolve `FROM ${IMAGE}`. */
  globalArgs: Map<string, string>;
}

export function isDockerfilePath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /^(Dockerfile|Containerfile)(\..+)?$/i.test(name) || /\.(dockerfile|containerfile)$/i.test(name);
}

function splitFlags(rest: string): { flags: Map<string, string[]>; args: string } {
  const flags = new Map<string, string[]>();
  let remaining = rest.trimStart();
  for (;;) {
    const match = /^--([a-z-]+)(?:=("[^"]*"|\S+))?\s*/i.exec(remaining);
    if (!match?.[1]) break;
    const name = match[1].toLowerCase();
    const value = match[2]?.replace(/^"|"$/g, "") ?? "";
    flags.set(name, [...(flags.get(name) ?? []), value]);
    remaining = remaining.slice(match[0].length);
  }
  return { flags, args: remaining.trim() };
}

export function parseImageReference(reference: string): { image: string; tag?: string; digest?: string } {
  const [withoutDigest, digest] = reference.split("@");
  const base = withoutDigest ?? reference;
  const slash = base.lastIndexOf("/");
  const colon = base.lastIndexOf(":");
  if (colon > slash) {
    return {
      image: base.slice(0, colon),
      tag: base.slice(colon + 1),
      ...(digest ? { digest } : {}),
    };
  }
  return { image: base, ...(digest ? { digest } : {}) };
}

export function parseDockerfile(path: string, content: string): DockerfileModel {
  const lines = content.split(/\r?\n/);
  const escapeDirective = /^#\s*escape\s*=\s*(`|\\)/im.exec(lines.slice(0, 5).join("\n"));
  const escape = escapeDirective?.[1] ?? "\\";
  const instructions: DockerInstruction[] = [];

  let index = 0;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const startLine = index + 1;
    let text = trimmed;
    while (text.endsWith(escape) && index + 1 < lines.length) {
      text = text.slice(0, -1);
      index += 1;
      const next = (lines[index] ?? "").trim();
      if (next.startsWith("#")) continue;
      text += ` ${next}`;
    }
    const heredoc = /<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(text);
    if (heredoc?.[1]) {
      const terminator = heredoc[1];
      while (index + 1 < lines.length) {
        index += 1;
        const body = lines[index] ?? "";
        if (body.trim() === terminator) break;
        text += `\n${body}`;
      }
    }
    const match = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(text);
    if (match?.[1]) {
      const { flags, args } = splitFlags(match[2] ?? "");
      instructions.push({
        keyword: match[1].toUpperCase(),
        args,
        flags,
        line: startLine,
        endLine: index + 1,
      });
    }
    index += 1;
  }

  const globalArgs = new Map<string, string>();
  const stages: DockerStage[] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === "FROM") {
      const [reference = "", as, name] = instruction.args.split(/\s+/);
      const resolved = reference.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}?/g, (whole, key: string) =>
        globalArgs.get(key) ?? whole,
      );
      const image = parseImageReference(resolved);
      stages.push({
        index: stages.length,
        ...(as?.toUpperCase() === "AS" && name ? { name } : {}),
        image: image.image,
        ...(image.tag !== undefined ? { tag: image.tag } : {}),
        ...(image.digest !== undefined ? { digest: image.digest } : {}),
        line: instruction.line,
        instructions: [],
      });
      continue;
    }
    const stage = stages.at(-1);
    if (stage) {
      stage.instructions.push(instruction);
    } else if (instruction.keyword === "ARG") {
      const [key, value] = instruction.args.split("=");
      if (key && value !== undefined) globalArgs.set(key.trim(), value.trim().replace(/^"|"$/g, ""));
    }
  }

  const slash = path.lastIndexOf("/");
  return {
    path,
    dir: slash >= 0 ? path.slice(0, slash) : "",
    instructions,
    stages,
    globalArgs,
  };
}
