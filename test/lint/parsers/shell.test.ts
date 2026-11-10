import { describe, expect, it } from "vitest";
import { commandTokens, shellTokens, shellWords, splitShellCommands } from "../../../src/lint/parsers/shell.js";

describe("bounded shell lexer", () => {
  it.each(["cargo $(echo --locked) test", "cargo `echo test`", "nix build <(echo --impure)", "cargo test >(cat)", 'cargo "unterminated'])(
    "leaves opaque syntax unanalyzed: %s", (command) => expect(shellTokens(command)).toEqual([]),
  );

  it("preserves literal quote boundaries and option values", () => {
    expect(shellTokens(`cargo test --features 'one two' '--locked'`).map((token) => [token.value, token.raw])).toEqual([
      ["cargo", "cargo"], ["test", "test"], ["--features", "--features"], ["one two", "'one two'"], ["--locked", "'--locked'"],
    ]);
    expect(shellWords(`env LABEL=cargo timeout cargo`)[0]).toBe("timeout");
    expect(shellWords("env FOO=1 sudo -u root nice -n 5 cargo test")).toEqual(["cargo", "test"]);
  });

  it.each(["sudo -nv cargo test", "sudo -nl cargo test", "sudo --list cargo test", "command -v cargo", "command -pV nix", "env --help cargo"])(
    "does not mistake wrapper queries for executions: %s", (command) => expect(commandTokens(command)).toEqual([]),
  );

  it("removes continuations only where the shell does, without inserting spaces", () => {
    const command = "nix bui\\\nld 'literal\\\ntext' \"joined\\\ntext\"";
    expect(shellWords(command)).toEqual(["nix", "build", "literal\\\ntext", "joinedtext"]);
    expect(splitShellCommands(command)).toEqual([{ command: "nix build 'literal\\\ntext' \"joinedtext\"", offset: 0 }]);
  });

  it("retains source offsets while ignoring heredoc contents and comments", () => {
    const script = "# preface\r\ncat <<-'END'\r\n\tnix build --impure\r\n\tEND\r\n  nix build .#ok && echo 'a; b'\r\n";
    expect(splitShellCommands(script)).toEqual([
      { command: "cat <<-'END'", offset: script.indexOf("cat") },
      { command: "nix build .#ok", offset: script.lastIndexOf("nix") },
      { command: "echo 'a; b'", offset: script.indexOf("echo") },
    ]);
  });

  it("does not split substitutions into executable commands", () => {
    expect(splitShellCommands("echo $(nix build; echo hi)\nnix build .#ok").map((item) => item.command)).toEqual([
      "echo $(nix build; echo hi)", "nix build .#ok",
    ]);
  });

  it.each(["f() {\n  nix build --impure\n}\nf", "function nix { echo hi; }\nnix build", "alias nix='echo'\nnix build"])(
    "does not analyze definitions as executions or assume an unshadowed tool: %s",
    (script) => expect(splitShellCommands(script)).toEqual([]),
  );

  it("does not evaluate GitHub expressions or split their operators", () => {
    const script = "nix build .#${{ matrix.pkg || 'fallback' }}\necho done";
    expect(splitShellCommands(script)[0]?.command).toBe(script.split("\n")[0]);
    expect(shellTokens("nix build ${{ matrix.pkg")).toEqual([]);
  });
});
