import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { actionInvocation, splitArgs } from "../../src/cli/action.js";
import { UsageError } from "../../src/cli/io.js";

describe("splitArgs", () => {
  it.each([
    ["", []],
    ["   ", []],
    ["lint .", ["lint", "."]],
    ["--format sarif\n--output  results.sarif\n", ["--format", "sarif", "--output", "results.sarif"]],
    [`--rule 'workflow/pin-runner=off'`, ["--rule", "workflow/pin-runner=off"]],
    [`--title "two words" x`, ["--title", "two words", "x"]],
    [`"a \\"quoted\\" \\\\ word"`, [`a "quoted" \\ word`]],
    [`'it''s'`, ["its"]],
    [`--empty ""`, ["--empty", ""]],
    [`pre"fix"ed`, ["prefixed"]],
    [`'C:\\path\\x'`, ["C:\\path\\x"]],
  ])("splits %j", (input, expected) => {
    expect(splitArgs(input)).toEqual(expected);
  });

  it("rejects unterminated quotes", () => {
    expect(() => splitArgs(`--x "open`)).toThrow(UsageError);
    expect(() => splitArgs("--x 'open")).toThrow(/Unterminated ' quote/);
  });
});

describe("actionInvocation", () => {
  const cwd = resolve("/proc");
  const workspace = resolve("/ws");

  it("prefers explicit argv", () => {
    const env = { INPUT_COMMAND: "scan", GITHUB_WORKSPACE: workspace };
    expect(actionInvocation(["lint", "."], env, cwd)).toEqual({ argv: ["lint", "."], cwd, env });
  });

  it("maps action inputs", () => {
    const env = {
      INPUT_COMMAND: " scan ",
      INPUT_ARGS: "--dry-run\n--fail-on 'warn'",
      INPUT_TOKEN: "ghs_secret",
      "INPUT_WORKING-DIRECTORY": "packages/app",
      GITHUB_WORKSPACE: workspace,
      GITHUB_TOKEN: "ignored",
    };
    const result = actionInvocation([], env, cwd);
    expect(result.argv).toEqual(["scan", "--dry-run", "--fail-on", "warn"]);
    expect(result.cwd).toBe(resolve(workspace, "packages/app"));
    expect(result.env.GITHUB_TOKEN).toBe("ghs_secret");
    expect(env.GITHUB_TOKEN).toBe("ignored");
  });

  it("defaults to lint in the workspace and keeps the ambient token", () => {
    const env = { INPUT_COMMAND: "", INPUT_TOKEN: "", GITHUB_WORKSPACE: workspace, GITHUB_TOKEN: "ambient" };
    expect(actionInvocation([], env, cwd)).toEqual({ argv: ["lint"], cwd: workspace, env });
  });

  it("falls back to the process cwd and honours absolute directories", () => {
    expect(actionInvocation([], {}, cwd).cwd).toBe(cwd);
    const abs = resolve("/elsewhere");
    expect(actionInvocation([], { "INPUT_WORKING-DIRECTORY": abs, GITHUB_WORKSPACE: workspace }, cwd).cwd).toBe(abs);
  });
});
