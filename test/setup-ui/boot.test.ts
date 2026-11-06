import { describe, expect, it } from "vitest";
import { parseBootResult } from "@/lib/boot";
import type { ToolResult } from "@/lib/transport";
import { makeState } from "./fixtures";

const text = (value: string): ToolResult["content"] => [{ type: "text", text: value }];

describe("parseBootResult", () => {
  it("hands the View the loopback session and the first snapshot", () => {
    const state = makeState("register");
    expect(parseBootResult({ content: text("Setup is ready."), structuredContent: { session: "session-1", state } })).toEqual({ boot: { session: "session-1", state } });
  });

  it("reports the tool's own message when setup could not start", () => {
    expect(parseBootResult({ isError: true, content: text("You need admin access to acme/widgets.") })).toEqual({ failure: "You need admin access to acme/widgets." });
  });

  it("falls back to a generic message for an empty failure", () => {
    expect(parseBootResult({ isError: true, content: [] })).toEqual({ failure: "Setup could not start." });
  });

  it.each([
    ["no structured content", { content: text("Setup is ready.") }],
    ["an empty session", { content: [], structuredContent: { session: "", state: makeState() } }],
    ["a malformed snapshot", { content: [], structuredContent: { session: "session-1", state: { repo: "acme/widgets" } } }],
    ["a non-string session", { content: [], structuredContent: { session: 7, state: makeState() } }],
  ] satisfies Array<[string, ToolResult]>)("rejects %s", (_name, result) => {
    expect(parseBootResult(result)).toEqual({ failure: "Copilot returned an unexpected setup response." });
  });
});
