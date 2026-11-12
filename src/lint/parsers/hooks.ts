import { commandTokens, splitShellCommands } from "./shell.js";
import { field, items, lineOfNode, parseErrors, parseYaml, scalarValue, stringValue } from "./yaml.js";
import type { ParseProblem, SourceFile } from "../types.js";

const EVENTS = "applypatch-msg|pre-applypatch|post-applypatch|pre-commit|pre-merge-commit|prepare-commit-msg|commit-msg|post-commit|pre-rebase|post-checkout|post-merge|pre-push|post-rewrite|sendemail-validate|push-to-checkout|pre-receive|update|post-receive|post-update|reference-transaction";
const SCRIPT_PATH = new RegExp(`^(?:\\.githooks|\\.husky)/(${EVENTS})$`);
export const isGitHookPath = (path: string): boolean => SCRIPT_PATH.test(path);
export const isPreCommitPath = (path: string): boolean => /^\.pre-commit-(?:config|hooks)\.ya?ml$/.test(path);

export interface HookCommand {
  path: string;
  line: number;
  command: string;
  words: string[];
  /** Present only for an explicitly declared pre-commit entry. */
  passFilenames?: boolean;
}

export function parseHooks(files: SourceFile[]): { commands: HookCommand[]; problems: ParseProblem[] } {
  const commands: HookCommand[] = [];
  const problems: ParseProblem[] = [];
  for (const file of files) {
    if (isGitHookPath(file.path)) {
      // Only POSIX-shell hooks: do not interpret Node/Python/PowerShell as shell.
      if (file.content.startsWith("#!") && !/^#![^\r\n]*\b(?:sh|bash|dash)\r?\n/.test(file.content)) continue;
      for (const { command, offset } of splitShellCommands(file.content)) {
        commands.push({ path: file.path, line: file.content.slice(0, offset).split("\n").length,
          command, words: commandTokens(command).map((token) => token.value) });
      }
    } else if (isPreCommitPath(file.path)) {
      const source = parseYaml(file.path, file.content);
      const errors = parseErrors(source);
      problems.push(...errors.map((error) => ({ path: file.path, ...error })));
      if (errors.length) continue;
      const definitions = file.path.includes("-hooks.")
        ? items(source, source.doc.contents)
        : items(source, field(source, source.doc.contents, "repos")?.value)
          .flatMap((repo) => items(source, field(source, repo, "hooks")?.value));
      for (const hook of definitions) {
        const entry = field(source, hook, "entry");
        const command = stringValue(entry?.value);
        if (!command) continue; // Remote hook behavior without a local entry is unknown.
        commands.push({ path: file.path, line: entry?.line ?? lineOfNode(source, hook), command,
          words: commandTokens(command).map((token) => token.value),
          passFilenames: scalarValue(field(source, hook, "pass_filenames")?.value) !== false });
      }
    }
  }
  return { commands, problems };
}
