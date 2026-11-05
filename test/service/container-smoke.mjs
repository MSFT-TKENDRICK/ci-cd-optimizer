import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

const { fetch, AbortSignal } = globalThis;
const name = `cicd-optimizer-smoke-${randomUUID()}`;
const secret = randomUUID();
const durable = Boolean(process.env.SMOKE_DATABASE_URL);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  ...process.env,
  APP_ID: "42",
  PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  WEBHOOK_SECRET: secret,
  ...(durable ? { DATABASE_URL: process.env.SMOKE_DATABASE_URL, WEBHOOK_QUEUE: "postgres" } : {}),
};
const docker = (...args) => execFileSync("docker", args, { env, encoding: "utf8", timeout: 30_000 }).trim();
let started = false;
try {
  docker("run", "--detach", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--publish", "127.0.0.1::3000", "--env", "APP_ID", "--env", "PRIVATE_KEY", "--env", "WEBHOOK_SECRET",
    ...(durable ? ["--env", "DATABASE_URL", "--env", "WEBHOOK_QUEUE", "--network", process.env.SMOKE_DOCKER_NETWORK] : []),
    "--env", "LOG_FORMAT=json", "--env", "LOG_LEVEL=warn", "ci-cd-optimizer:smoke");
  started = true;
  const port = docker("port", name, "3000/tcp").split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await fetch(`${origin}/ping`, { signal: AbortSignal.timeout(1000) });
      assert.equal(health.status, 200);
      assert.equal(await health.text(), "PONG");
      ready = true;
      break;
    } catch (error) {
      lastError = error;
      if (docker("inspect", "--format", "{{.State.Running}}", name) !== "true") break;
      await setTimeout(500);
    }
  }
  assert.ok(ready, `Container did not become reachable through its published port: ${lastError}`);
  const user = docker("inspect", "--format", "{{.Config.User}}", name);
  assert.ok(user === "nonroot" || user === "65532", `Expected non-root runtime, got ${user}`);
  const body = JSON.stringify({ zen: "Local smoke test; no GitHub API access." });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  for (const signed of [true, false]) {
    const response = await fetch(`${origin}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": randomUUID(),
        ...(signed ? { "x-hub-signature-256": signature } : {}),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    await response.text();
    assert.equal(response.status, signed ? 200 : 400);
  }
  if (durable) {
    assert.ok(process.env.SMOKE_DATABASE_CONTAINER, "Durable smoke needs its test database container ID");
    const id = randomUUID();
    const payload = JSON.stringify({
      installation: { id: 123 }, repository: { name: "smoke", full_name: "acme/smoke", owner: { login: "acme" }, default_branch: "main" },
      ref: "refs/heads/feature", commits: [],
    });
    const response = await fetch(`${origin}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-github-event": "push", "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
      },
      body: payload, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    await response.text();
    let status;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      status = docker("exec", process.env.SMOKE_DATABASE_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atc",
        `SELECT status FROM webhook_jobs WHERE delivery_id = '${id}'`);
      if (status === "completed" || status === "failed") break;
      await setTimeout(500);
    }
    assert.equal(status, "completed", "The production worker did not process the persisted webhook");
  }
  console.log(`Container smoke passed (${durable ? "postgres" : "direct"}): non-root startup, published-port health, signed webhook, unsigned rejection${durable ? ", durable worker completion" : ""}.`);
} catch (error) {
  if (started) console.error(docker("logs", name));
  throw error;
} finally {
  if (started) docker("rm", "--force", name);
}
