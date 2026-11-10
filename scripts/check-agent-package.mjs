import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const root = process.cwd();
const artifacts = join(root, ".agent-artifacts");
await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(artifacts, "package-"));
const env = { ...process.env, TEMP: work, TMP: work, TMPDIR: work, npm_config_cache: join(work, "npm-cache"), GITHUB_TOKEN: "unused-smoke-token", GH_TOKEN: "unused-smoke-token" };
delete env.CICD_OPTIMIZER_PLUGIN_ROOT;
delete env.PLUGIN_ROOT;
const workflow = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n";

async function protocol(args, cwd, run) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let failure;
  let nextId = 0;
  const pending = new Map();
  const notifications = [];
  const fail = (error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    child.kill();
  };
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.on("error", fail);
  child.once("error", fail);
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    try {
      buffer += chunk;
      assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024, "Unbounded stdout");
      for (let newline; (newline = buffer.indexOf("\n")) !== -1;) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          assert.ok(!message.method, "Read-only agents must not request client writes or executions");
          const waiter = pending.get(message.id);
          assert.ok(waiter, "Unexpected JSON-RPC response");
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        } else {
          notifications.push(message);
          assert.ok(notifications.length <= 100, "Unbounded notifications");
        }
      }
    } catch (error) { fail(error); }
  });
  const exited = new Promise((resolveExit) => child.once("close", (code, signal) => {
    if (pending.size) fail(new Error(`Agent exited during a request (${code ?? signal}): ${stderr}`));
    resolveExit({ code, signal });
  }));
  const timer = setTimeout(() => fail(new Error(`Agent smoke timed out: ${stderr}`)), 20_000);
  const send = (method, params, id) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params })}\n`);
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject });
    send(method, params, id);
  });
  try {
    await run({ request, notify: (method, params) => send(method, params), notifications });
    child.stdin.end();
    const result = await exited;
    if (failure) throw failure;
    assert.equal(result.code, 0, `Agent exit failed: ${stderr}`);
    assert.equal(buffer.trim(), "", "Unterminated protocol output");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}

async function mcp(args, cwd) {
  await protocol(args, cwd, async ({ request, notify }) => {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } });
    assert.ok(initialized.capabilities.tools);
    notify("notifications/initialized", {});
    const { tools } = await request("tools/list", {});
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["effective_config", "explain_rule", "fix_preview", "lint", "lint_content", "list_rules", "validate_review_project"]);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    const lint = await request("tools/call", { name: "lint", arguments: {} });
    assert.ok(!lint.isError);
    assert.equal(lint.structuredContent.localRulesIgnored, true);
    assert.ok(lint.structuredContent.diagnostics.some((item) => item.ruleId === "workflow/job-timeout"));
    const preview = await request("tools/call", { name: "fix_preview", arguments: { ruleIds: ["workflow/job-timeout"] } });
    assert.equal(preview.structuredContent.written, false);
    assert.equal(preview.structuredContent.localRulesIgnored, true);
    assert.equal(preview.structuredContent.files[0].oldText, workflow);
    assert.match(preview.structuredContent.files[0].newText, /timeout-minutes/);
  });
}

async function acp(args, cwd) {
  await protocol(args, cwd, async ({ request, notifications }) => {
    const initialized = await request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(initialized.agentCapabilities.promptCapabilities.embeddedContext, true);
    const { sessionId } = await request("session/new", { cwd, mcpServers: [] });
    const lint = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/lint" }, { type: "text", text: ".github/workflows/ci.yml" }] });
    assert.equal(lint.stopReason, "end_turn");
    assert.ok(notifications.some((message) => message.params?.update?.rawOutput?.diagnostics?.some((item) => item.ruleId === "workflow/job-timeout")));
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/fix-preview" }] });
    const preview = notifications.find((message) => Array.isArray(message.params?.update?.content) && message.params.update.content.some((item) => item.type === "diff"));
    assert.ok(preview, "ACP must emit a complete fix-preview diff");
    assert.equal(preview.params.update.rawOutput.written, false);
    assert.equal(preview.params.update.content[0].oldText, workflow);
  });
}

try {
  assert.ok(process.env.npm_execpath, "Run this check using npm run test:agents:package");
  await stat(join(root, "dist", "mcp-bin.js"));
  const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", work], {
    cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  }))[0];
  assert.match(packed.filename, /^[\w.-]+\.tgz$/);
  const paths = new Set(packed.files.map((file) => file.path));
  for (const path of [
    "dist/bin.js", "dist/lint-bin.js", "dist/mcp-bin.js", "dist/acp-bin.js", "docs/agents.md",
    "plugins/ci-cd-optimizer/plugin.json", "plugins/ci-cd-optimizer/mcp.json", "plugins/ci-cd-optimizer/server/cicd-agents.mjs",
    ...["optimize-ci-pipeline", "triage-cicd-findings", "analyze-ci-run"].map((name) => `plugins/ci-cd-optimizer/skills/${name}/SKILL.md`),
  ]) assert.ok(paths.has(path), `Missing packed file: ${path}`);
  const unpacked = join(work, "unpacked");
  await mkdir(unpacked);
  execFileSync("tar", ["-xzf", join(work, packed.filename), "-C", unpacked], { cwd: root, env, timeout: 30_000 });
  const pkg = join(unpacked, "package");
  const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
  for (const bin of ["ci-cd-optimizer", "cicd-lint", "cicd-mcp", "cicd-acp"]) {
    const entry = resolve(pkg, manifest.bin[bin]);
    assert.equal(execFileSync(process.execPath, [entry, "--version"], { cwd: work, env, encoding: "utf8", timeout: 15_000 }).trim(), manifest.version);
    assert.match(execFileSync(process.execPath, [entry, "--help"], { cwd: work, env, encoding: "utf8", timeout: 15_000 }), /Usage:/);
  }
  const fixture = join(work, "workspace");
  await mkdir(join(fixture, ".github", "workflows"), { recursive: true });
  const target = join(fixture, ".github", "workflows", "ci.yml");
  await writeFile(target, workflow);
  await writeFile(join(fixture, ".github", "ci-cd-optimizer.yml"), "schemaVersion: 1\nextends: [recommended]\nlocalRules: [forbidden.mjs]\n");
  await writeFile(join(fixture, "forbidden.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./executed", import.meta.url), "unsafe");\nthrow new Error("Forbidden import");\n');
  const before = await stat(target, { bigint: true });
  await mcp([join(pkg, "dist", "mcp-bin.js"), "--root", fixture], fixture);
  await acp([join(pkg, "dist", "acp-bin.js")], fixture);
  // The committed plugin bundle must work as a single file, without adjacent dist/ modules or a build.
  const standalone = join(work, "standalone.mjs");
  await copyFile(join(pkg, "plugins", "ci-cd-optimizer", "server", "cicd-agents.mjs"), standalone);
  await mcp([standalone, "mcp", "--root", fixture], fixture);
  await acp([standalone, "acp"], fixture);
  assert.equal(await readFile(target, "utf8"), workflow);
  assert.equal((await stat(target, { bigint: true })).mtimeNs, before.mtimeNs);
  await assert.rejects(stat(join(fixture, "executed")), { code: "ENOENT" });
  console.log("Package verified: four bins, canonical plugin/skills/docs, packed MCP/ACP and standalone bundle roundtrips; no writes or local-rule imports.");
} finally {
  await rm(work, { recursive: true, force: true });
}
