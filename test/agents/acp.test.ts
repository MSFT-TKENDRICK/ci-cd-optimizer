import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { client, methods, PROTOCOL_VERSION, type ActiveSession, type ClientContext, type SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACP_COMMANDS, createAcpAgent, helpText } from "../../src/agents/acp.js";
import { VERSION } from "../../src/version.js";
import { forbiddenLocalRule, MISSING_TIMEOUT, tempDirs, WORKFLOW, write } from "./helpers.js";
import { LIMITS } from "../../src/agents/safety.js";

const WITH_TIMEOUT = MISSING_TIMEOUT.replace("runs-on: ubuntu-24.04\n", "runs-on: ubuntu-24.04\n    timeout-minutes: 10\n");

const dirs = tempDirs();
let repo: string;

beforeEach(async () => {
  repo = await dirs.make("cicd-acp-repo-");
  await write(repo, WORKFLOW, MISSING_TIMEOUT);
});
afterEach(() => dirs.cleanup());

/** Runs `op` against the agent over an in-memory connection, after `initialize`. */
function withAgent<T>(op: (ctx: ClientContext) => Promise<T>): Promise<T> {
  return client({ name: "test-client" }).connectWith(createAcpAgent(), async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    return op(ctx);
  });
}

/** Collects every update of one prompt turn, plus its joined message text and stop reason. */
async function turn(session: ActiveSession, prompt: Parameters<ActiveSession["prompt"]>[0]) {
  const done = session.prompt(prompt);
  const updates: SessionUpdate[] = [];
  for (;;) {
    const message = await session.nextUpdate();
    if (message.kind === "stop") break;
    updates.push(message.update);
  }
  const text = updates
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : ""))
    .join("");
  return { updates, text, stopReason: (await done).stopReason };
}

/** Starts a session and drains the `available_commands_update` sent right after `session/new`. */
async function start(ctx: ClientContext, cwd = repo) {
  const session = await ctx.buildSession(cwd).start();
  const first = await session.nextUpdate();
  expect(first.kind === "session_update" && first.update.sessionUpdate).toBe("available_commands_update");
  return session;
}

describe("ACP agent", () => {
  it("initializes with its identity and capabilities, then advertises its commands", async () => {
    await client().connectWith(createAcpAgent(), async (ctx) => {
      const init = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(init.agentInfo).toMatchObject({ name: "ci-cd-optimizer", version: VERSION });
      expect(init.agentCapabilities?.promptCapabilities).toMatchObject({ embeddedContext: true, image: false, audio: false });
      expect(init.authMethods).toEqual([]);
      const session = await ctx.buildSession(repo).start();
      const message = await session.nextUpdate();
      expect(message.kind === "session_update" && message.update).toEqual({ sessionUpdate: "available_commands_update", availableCommands: ACP_COMMANDS });
    });
  });

  it("lints the workspace with a tool call, absolute locations, and a summary", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const result = await turn(session, "/lint");
      expect(result.stopReason).toBe("end_turn");
      const call = result.updates.find((update) => update.sessionUpdate === "tool_call");
      expect(call).toMatchObject({ title: "Lint workspace", kind: "search", status: "in_progress" });
      const done = result.updates.find((update) => update.sessionUpdate === "tool_call_update");
      expect(done).toMatchObject({ status: "completed" });
      expect(done?.sessionUpdate === "tool_call_update" && done.locations).toContainEqual({ path: join(repo, ".github", "workflows", "ci.yml"), line: expect.any(Number) });
      expect(result.text).toMatch(/\*\*0 error\(s\), [1-9]\d* warning\(s\), \d+ info\*\* in 1 analyzed file\(s\) \(config: defaults\)/);
      expect(result.text).toContain("workflow/job-timeout");
      expect(result.text).toContain("_(autofix available)_");
      expect(result.text).toContain("Run `/fix-preview`");
    });
  });

  it("filters by --min and reports unmatched paths", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const errorsOnly = await turn(session, "/lint --min error");
      expect(errorsOnly.text).toMatch(/\*\*0 error\(s\), 0 warning\(s\), 0 info\*\*/);
      const unmatched = await turn(session, "/lint docs/nothing.yml");
      expect(unmatched.text).toContain("No analyzed file matched: `docs/nothing.yml`");
      const bad = await turn(session, "/lint --min loud");
      expect(bad.text).toContain("min must be info, warn, or error\\.");
      expect(bad.stopReason).toBe("end_turn");
    });
  });

  it("lints attached content instead of the file on disk", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const uri = pathToFileURL(join(repo, ".github", "workflows", "ci.yml")).href;
      const result = await turn(session, [{ type: "resource", resource: { uri, text: WITH_TIMEOUT, mimeType: "text/yaml" } }]);
      expect(result.updates.find((update) => update.sessionUpdate === "tool_call")).toMatchObject({ title: `Lint ${WORKFLOW}` });
      expect(result.text).not.toContain("workflow/job-timeout");
      const linked = await turn(session, [{ type: "text", text: "/lint" }, { type: "resource_link", uri, name: "ci.yml" }]);
      expect(linked.text).toContain("workflow/job-timeout");
    });
  });

  it("refuses attachments outside the workspace and reports ignored blocks", async () => {
    const other = await dirs.make("cicd-acp-other-");
    await write(other, WORKFLOW, MISSING_TIMEOUT);
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const outside = await turn(session, [{ type: "resource_link", uri: pathToFileURL(join(other, "x.yml")).href, name: "x.yml" }]);
      expect(outside.text).toMatch(/\*\*Error:\*\* .*outside/);
      const remote = await turn(session, [{ type: "resource_link", uri: "https://example.com/ci.yml", name: "ci.yml" }]);
      expect(remote.text).toContain("is not a workspace file");
      const image = await turn(session, [{ type: "text", text: "/lint" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
      expect(image.text).toContain("_Ignored 1 attachment(s) that are not text files._");
    });
  });

  it("previews fixes as diffs without writing", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const result = await turn(session, "/fix-preview");
      const diff = result.updates.find((update) => update.sessionUpdate === "tool_call");
      expect(diff).toMatchObject({ title: `Proposed fix for ${WORKFLOW} (preview, not applied)`, status: "completed", rawOutput: { written: false } });
      const content = diff?.sessionUpdate === "tool_call" ? diff.content?.[0] : undefined;
      expect(content).toMatchObject({ type: "diff", path: join(repo, ".github", "workflows", "ci.yml"), oldText: MISSING_TIMEOUT });
      expect(content?.type === "diff" && content.newText).toContain("timeout-minutes");
      expect(result.text).toMatch(/\*\*[1-9]\d* fix\(es\) in 1 file\(s\)\*\* — previewed only; nothing was written\./);
      expect(await readFile(join(repo, ".github", "workflows", "ci.yml"), "utf8")).toBe(MISSING_TIMEOUT);
    });
  });

  it("says when no autofix applies", async () => {
    const empty = await dirs.make("cicd-acp-empty-");
    await withAgent(async (ctx) => {
      const session = await start(ctx, empty);
      const result = await turn(session, "/fix-preview");
      expect(result.text).toBe("No safe autofixes apply to the analyzed selected files.");
      expect(result.updates.some((update) => update.sessionUpdate === "tool_call")).toBe(false);
    });
  });

  it("never executes local rules and bounds every emitted message", async () => {
    const marker = await forbiddenLocalRule(repo);
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      for (const prompt of ["/lint", "/fix-preview", "/config", "/explain workflow/job-timeout", "/rules"]) {
        const result = await turn(session, prompt);
        expect(result.text).not.toContain("**Error:**");
        for (const update of result.updates) expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(LIMITS.outputBytes);
      }
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains rules, with usage and did-you-mean errors", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const known = await turn(session, "/explain workflow/job-timeout");
      expect(known.text).toMatch(/^```text\n[\s\S]*workflow\/job-timeout[\s\S]*```\n\nDocs: https?:\/\//);
      const missing = await turn(session, "/explain");
      expect(missing.text).toContain("Usage: /explain &lt;rule\\-id&gt;\\. List the rules with /rules\\.");
      const typo = await turn(session, "/explain workflow/job-timout");
      expect(typo.text).toContain('Did you mean "workflow/job\\-timeout"');
    });
  });

  it("lists rules and the effective configuration", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const rules = await turn(session, "/rules timeout");
      expect(rules.text).toMatch(/^\*\*[1-9]\d* rule\(s\)\*\* matching `timeout`:/);
      expect(rules.text).toContain("`workflow/job-timeout` (warn, fixable)");
      const config = await turn(session, "/config");
      expect(config.text).toContain("**Configuration:** none (defaults)");
      expect(config.text).toMatch(/\*\*Presets:\*\* `recommended`/);
      expect(config.text).toContain("Inspect a rule with `/explain <rule-id>`.");
    });
  });

  it("answers free text and /help with the command list", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const chat = await turn(session, "why is my build slow?");
      expect(chat.text).toBe(`This agent runs commands rather than chat. ${helpText()}`);
      const help = await turn(session, "/help");
      expect(help.text).toBe(helpText());
      for (const command of ACP_COMMANDS) expect(help.text).toContain(`/${command.name}`);
    });
  });

  it("explicitly rejects unsupported MCP servers and extra directories", async () => {
    const extra = await dirs.make("cicd-acp-extra-");
    await withAgent(async (ctx) => {
      await expect(ctx
        .buildSession(repo)
        .withMcpServer({ name: "other", command: "node", args: [], env: [] })
        .start()).rejects.toMatchObject({ code: -32602 });
      await expect(ctx.buildSession(repo).withAdditionalDirectories([extra]).start()).rejects.toMatchObject({ code: -32602 });
    });
  });

  it("rejects relative, missing, and unknown sessions", async () => {
    await withAgent(async (ctx) => {
      await expect(ctx.buildSession("relative/dir").start()).rejects.toMatchObject({ code: -32602 });
      await expect(ctx.buildSession(join(repo, "missing")).start()).rejects.toMatchObject({ code: -32602 });
      await expect(ctx.request(methods.agent.session.prompt, { sessionId: "nope", prompt: [{ type: "text", text: "/lint" }] })).rejects.toMatchObject({
        code: -32002,
      });
    });
  });

  it("rejects a concurrent prompt and honors cancel", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const first = ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "/lint" }] });
      const second = ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "/lint" }] });
      await expect(second).rejects.toMatchObject({ code: -32600 });
      await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      expect((await first).stopReason).toBe("cancelled");
      const after = await ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "/help" }] });
      expect(after.stopReason).toBe("end_turn");
    });
  });

  it("uses every text block, including quoted paths and later-line arguments", async () => {
    await write(repo, ".github/workflows/with space.yml", MISSING_TIMEOUT);
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      const explained = await turn(session, [{ type: "text", text: "/explain" }, { type: "text", text: "workflow/job-timeout" }]);
      expect(explained.text).toContain("workflow/job-timeout");
      const lint = await turn(session, [{ type: "text", text: "/lint\n" }, { type: "text", text: '".github/workflows/with space.yml"' }]);
      expect(lint.updates.find((update) => update.sessionUpdate === "tool_call")).toMatchObject({ title: "Lint .github/workflows/with space.yml" });
      expect(lint.text).not.toContain("`.github/workflows/ci.yml:");
      expect((await turn(session, '/lint "unclosed')).text).toContain("Unclosed quote");
    });
  });

  it("rejects malformed or ambiguous resource links without a protocol crash", async () => {
    await withAgent(async (ctx) => {
      const session = await start(ctx);
      for (const uri of ["file:///bad%xx.yml", `${pathToFileURL(join(repo, WORKFLOW)).href}?other`, "file://%"]) {
        const result = await turn(session, [{ type: "resource_link", uri, name: "untrusted.yml" }]);
        expect(result.text).toContain("invalid file URI");
        expect(result.stopReason).toBe("end_turn");
      }
    });
  });

  it("bounds concurrently created sessions and prompt bytes", async () => {
    await client().connectWith(createAcpAgent({ maxSessions: 2 }), async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => ctx.buildSession(repo).start()));
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
      const session = attempts.find((attempt) => attempt.status === "fulfilled");
      if (session?.status !== "fulfilled") throw new Error("Session not created");
      await expect(ctx.request(methods.agent.session.prompt, { sessionId: session.value.sessionId, prompt: [{ type: "text", text: "x".repeat(262145) }] })).rejects.toMatchObject({ code: -32602 });
    });
  });
});
