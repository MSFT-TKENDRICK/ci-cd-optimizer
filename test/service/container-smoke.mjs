import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";
import { HEAD, WORKFLOW, pullRequestPayload, startGitHubFixture } from "./container-github.mjs";

const { fetch, AbortSignal } = globalThis;
const name = `cicd-optimizer-smoke-${randomUUID()}`;
const network = `${name}-network`;
const secret = randomUUID();
const durable = Boolean(process.env.SMOKE_DATABASE_URL);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let github;
const env = {
  ...process.env,
  APP_ID: "42",
  PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  WEBHOOK_SECRET: secret,
  CICD_OPTIMIZER_ACP: "true",
  CICD_OPTIMIZER_ACP_AUTH: "github-user",
  CICD_OPTIMIZER_ACP_REPOSITORIES: "acme/widgets:42",
  GHE_PROTOCOL: "http",
  ...(durable ? { DATABASE_URL: process.env.SMOKE_DATABASE_URL, WEBHOOK_QUEUE: "postgres" } : {}),
};
const docker = (...args) => execFileSync("docker", args, { env, encoding: "utf8", timeout: 30_000 }).trim();
let containerCreated = false;
let networkCreated = false;
let databaseAttached = false;
let databasePaused = false;
const failures = [];

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    github.assertClean();
    if (predicate()) return;
    await setTimeout(250);
  }
  assert.fail(message);
}

function startContainer(gateway, publish = false) {
  docker("create", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    ...(publish ? ["--publish", "127.0.0.1::3000"] : []),
    "--env", "APP_ID", "--env", "PRIVATE_KEY", "--env", "WEBHOOK_SECRET",
    "--env", "CICD_OPTIMIZER_ACP", "--env", "CICD_OPTIMIZER_ACP_AUTH", "--env", "CICD_OPTIMIZER_ACP_REPOSITORIES",
    "--network", publish ? "bridge" : network, "--add-host", `github-smoke:${gateway}`, "--env", "GHE_HOST", "--env", "GHE_PROTOCOL",
    ...(durable ? ["--env", "DATABASE_URL", "--env", "WEBHOOK_QUEUE"] : []),
    "--env", "LOG_FORMAT=json", "--env", "LOG_LEVEL=warn", "ci-cd-optimizer:smoke");
  containerCreated = true;
  if (publish) docker("network", "connect", network, name);
  docker("start", name);
  const user = docker("inspect", "--format", "{{.Config.User}}", name);
  assert.ok(user === "nonroot" || user === "65532", `Expected non-root runtime, got ${user}`);
}

async function waitForHealth(origin) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await fetch(`${origin}/ping`, { signal: AbortSignal.timeout(1000) });
      assert.equal(health.status, 200);
      assert.equal(await health.text(), "PONG");
      return;
    } catch (error) {
      lastError = error;
      if (docker("inspect", "--format", "{{.State.Running}}", name) !== "true") break;
      await setTimeout(500);
    }
  }
  assert.fail(`Container did not become reachable at ${origin}: ${lastError}`);
}

async function readiness(origin, expected) {
  const started = Date.now();
  const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, expected);
  assert.equal(await response.text(), expected === 200 ? "READY" : "NOT READY");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(Date.now() - started < 2500, "Readiness must respond independently of a stalled database");
}

function isolatedOrigin() {
  const networks = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", name));
  assert.deepEqual(Object.keys(networks), [network], "Authenticated scenarios must have no external network");
  assert.ok(networks[network].IPAddress, "The isolated container has no address");
  return `http://${networks[network].IPAddress}:3000`;
}

const sql = (query) => docker("exec", process.env.SMOKE_DATABASE_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atc", query);
const job = (id) => sql(`SELECT status || ':' || attempts FROM webhook_jobs WHERE delivery_id = '${id}'`);
const completed = (owner) => github.checks.filter((check) => check.owner === owner && check.status === "completed");
function verifyChecks(owner, count) {
  const checks = completed(owner);
  assert.equal(checks.length, count);
  for (const check of checks) {
    assert.equal(check.head_sha, HEAD);
    assert.equal(check.conclusion, "failure");
    assert.equal(check.output.title, "1 new finding");
    assert.equal(check.output.annotations.length, 1);
    assert.equal(check.output.annotations[0].path, WORKFLOW);
    assert.equal(check.output.annotations[0].title, "workflow/job-timeout");
    assert.equal(check.output.annotations[0].annotation_level, "failure");
  }
}

try {
  // Authenticated scenarios run on this internal-only network after the published-port health check.
  docker("network", "create", "--internal", network);
  networkCreated = true;
  const gateway = docker("network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network);
  assert.ok(gateway, "The isolated test network has no gateway");
  github = await startGitHubFixture(publicKey, gateway);
  env.GHE_HOST = `github-smoke:${github.port}`;
  if (durable) {
    assert.ok(process.env.SMOKE_DATABASE_CONTAINER, "Durable smoke needs its test database container ID");
    docker("network", "connect", "--alias", new URL(process.env.SMOKE_DATABASE_URL).hostname, network, process.env.SMOKE_DATABASE_CONTAINER);
    databaseAttached = true;
  }
  startContainer(gateway, true);
  const port = docker("port", name, "3000/tcp").split(":").at(-1);
  await waitForHealth(`http://127.0.0.1:${port}`);
  if (durable) await readiness(`http://127.0.0.1:${port}`, 200);
  docker("network", "disconnect", "bridge", name);
  let origin = isolatedOrigin();
  for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
    const response = await fetch(`${origin}/acp`, { method, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 401, `Hosted ACP ${method} must authenticate at ${durable ? "durable ingress" : "direct ingress"}`);
    await response.text();
  }
  assert.equal(github.requests.length, 0, "ACP must not borrow the App's installation credentials");
  const send = async (event, payload, signature = "valid", id = randomUUID()) => {
    const body = JSON.stringify(payload);
    const response = await fetch(`${origin}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": id,
        ...(signature === "missing" ? {} : { "x-hub-signature-256": `sha256=${createHmac("sha256", signature === "valid" ? secret : "wrong-secret").update(body).digest("hex")}` }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    await response.text();
    github.assertClean();
    return { id, status: response.status };
  };
  assert.equal((await send("ping", { zen: "Local image smoke test" })).status, 200);
  assert.equal(github.requests.length, 0, "Ping must not access the API");

  for (let count = 1; count <= 2; count += 1) {
    const response = await send("pull_request", pullRequestPayload());
    assert.equal(response.status, 200);
    await waitFor(() => completed("acme").length === count, "The image did not publish its PR analysis");
    if (durable) await waitFor(() => job(response.id) === "completed:1", "The worker did not complete the authenticated delivery");
    verifyChecks("acme", count);
  }
  assert.deepEqual(github.issued, [123], "The valid installation token should be reused");

  const requestsBefore = github.requests.length;
  for (const signature of ["missing", "invalid"]) {
    const response = await send("pull_request", pullRequestPayload(), signature);
    assert.equal(response.status, 400);
    assert.equal(github.requests.length, requestsBefore, "Rejected signatures must not trigger authentication or API writes");
    if (durable) assert.equal(job(response.id), "", "Rejected signatures must not be persisted");
  }

  const denied = await send("pull_request", pullRequestPayload(456));
  assert.equal(denied.status, durable ? 200 : 403);
  if (durable) await waitFor(() => job(denied.id) === "pending:1", "A denied installation must be retained for retry");
  assert.deepEqual(github.denied, [456]);
  assert.equal(github.checks.filter((check) => check.owner === "blocked").length, 0, "Token denial must not create a check");
  github.restoreInstallation();
  if (durable) {
    // Advance only this synthetic job's availability; retry timing is covered by the queue tests.
    assert.ok(sql(`UPDATE webhook_jobs SET available_at = clock_timestamp() WHERE delivery_id = '${denied.id}' AND status = 'pending' AND attempts = 1 RETURNING delivery_id`).includes(denied.id));
    await waitFor(() => job(denied.id) === "completed:2", "The real worker did not retry after installation access returned");
  } else {
    assert.equal((await send("pull_request", pullRequestPayload(456), "valid", denied.id)).status, 200);
  }
  await waitFor(() => completed("blocked").length === 1, "Restored installation access did not complete analysis");
  verifyChecks("blocked", 1);
  assert.deepEqual(github.issued, [123, 456], "Installation tokens must remain isolated");
  if (durable) {
    assert.equal((await send("pull_request", pullRequestPayload(456), "valid", denied.id)).status, 200);
    assert.equal(job(denied.id), "completed:2", "Completed redelivery must not reset the job");
    assert.equal(github.checks.length, 3, "Completed redelivery must not duplicate the check");

    const stalled = github.stallNextCheck("acme");
    const interrupted = await send("pull_request", pullRequestPayload());
    assert.equal(interrupted.status, 200);
    await waitFor(() => stalled.reached, "The real worker did not reach the pre-write crash boundary");
    assert.equal(stalled.deliveryId, interrupted.id);
    assert.equal((await send("pull_request", pullRequestPayload(), "valid", interrupted.id)).status, 200);
    const following = await send("pull_request", pullRequestPayload());
    assert.equal(following.status, 200);
    const independent = await send("pull_request", pullRequestPayload(456));
    assert.equal(independent.status, 200);
    await waitFor(() => job(independent.id) === "completed:1", "A blocked scope prevented independent work");
    verifyChecks("blocked", 2);
    assert.equal(github.checks.filter((check) => check.owner === "acme").length, 2, "Same-scope work bypassed the claimed job");
    for (const id of [interrupted.id, following.id]) {
      assert.equal(job(id), "pending:0", "Accepted work must remain pending until its handler commits");
      assert.equal(sql(`SELECT (delivery->>'id' = delivery_id AND completed_at IS NULL AND last_error IS NULL)::text FROM webhook_jobs WHERE delivery_id = '${id}'`), "true");
    }

    const previousContainer = docker("inspect", "--format", "{{.Id}}", name);
    docker("kill", "--signal=KILL", name);
    assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", name), "137", "The crash scenario must bypass graceful shutdown");
    await waitFor(() => stalled.disconnected, "The killed worker did not drop its stalled HTTP request");
    for (const id of [interrupted.id, following.id]) assert.equal(job(id), "pending:0", "Process death lost or completed pending work");
    docker("rm", name);
    containerCreated = false;
    startContainer(gateway);
    assert.notEqual(docker("inspect", "--format", "{{.Id}}", name), previousContainer, "Recovery must use a fresh container");
    origin = isolatedOrigin();
    await waitForHealth(origin);
    await readiness(origin, 200);
    for (const [id, attempts] of [[interrupted.id, 2], [following.id, 1]]) {
      // The killed worker's claim counts as an attempt.
      await waitFor(() => job(id) === `completed:${attempts}`, "A fresh image process did not recover accepted work");
      assert.equal(sql(`SELECT (delivery IS NULL AND completed_at IS NOT NULL AND last_error IS NULL)::text FROM webhook_jobs WHERE delivery_id = '${id}'`), "true");
    }
    verifyChecks("acme", 4);
    assert.deepEqual(completed("acme").slice(2).map((check) => check.deliveryId), [interrupted.id, following.id], "Recovery did not preserve same-scope FIFO");
    assert.deepEqual(github.issued, [123, 456, 123], "The fresh process must authenticate again, then reuse its installation token");
    const recoveredRequests = github.requests.length;
    for (const [id, attempts] of [[interrupted.id, 2], [following.id, 1]]) {
      assert.equal((await send("pull_request", pullRequestPayload(), "valid", id)).status, 200);
      assert.equal(job(id), `completed:${attempts}`);
    }
    assert.equal(github.requests.length, recoveredRequests, "Completed redelivery after replacement must not access the API");
    assert.equal(github.checks.length, 6, "Crash recovery or completed redelivery duplicated a pre-write check");

    docker("pause", process.env.SMOKE_DATABASE_CONTAINER);
    databasePaused = true;
    assert.equal(docker("inspect", "--format", "{{.State.Paused}}", process.env.SMOKE_DATABASE_CONTAINER), "true");
    await setTimeout(1100);
    await readiness(origin, 503);
    await waitForHealth(origin);
    const unavailableStarted = Date.now();
    const unavailable = await send("pull_request", pullRequestPayload());
    assert.equal(unavailable.status, 503, "Unavailable persistence must not be acknowledged as HTTP 200/202");
    assert.ok(Date.now() - unavailableStarted < 8000, "Persistence failure must leave margin before GitHub's ten-second deadline");
    assert.equal(github.requests.length, recoveredRequests, "No analysis may run while persistence is unavailable");
    docker("unpause", process.env.SMOKE_DATABASE_CONTAINER);
    databasePaused = false;
    await waitFor(() => job(unavailable.id) === "completed:1", "Late persistence did not recover after the database resumed");
    await readiness(origin, 200);
    verifyChecks("acme", 5);
    const lateRequests = github.requests.length;
    assert.equal((await send("pull_request", pullRequestPayload(), "valid", unavailable.id)).status, 200);
    assert.equal(job(unavailable.id), "completed:1");
    assert.equal(github.requests.length, lateRequests, "Redelivery duplicated a late-committed delivery");
    assert.equal(github.checks.length, 7);
  }
  github.assertClean();
  docker("stop", "--time", "10", name);
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", name), "0", "SIGTERM did not shut down cleanly");
} catch (error) {
  failures.push(error);
  if (github) {
    console.error("Synthetic API trace:", JSON.stringify({ requests: github.requests, issued: github.issued, denied: github.denied }));
    try { github.assertClean(); } catch (fixtureError) { failures.push(fixtureError); }
  }
  if (containerCreated) {
    try { console.error(docker("logs", name)); } catch (logError) { failures.push(logError); }
  }
} finally {
  for (const args of [
    ...(databasePaused ? [["unpause", process.env.SMOKE_DATABASE_CONTAINER]] : []),
    ...(containerCreated ? [["rm", "--force", name]] : []),
    ...(databaseAttached ? [["network", "disconnect", network, process.env.SMOKE_DATABASE_CONTAINER]] : []),
    ...(networkCreated ? [["network", "rm", network]] : []),
  ]) {
    try { docker(...args); } catch (error) { failures.push(error); }
  }
  try { await github?.close(); } catch (error) { failures.push(error); }
}
if (failures.length) throw new AggregateError(failures, "Container smoke or cleanup failed");
console.log(`Container smoke passed (${durable ? "postgres" : "direct"}): non-root startup, published-port health, isolated signed/unsigned webhooks, JWT and installation-token HTTP exchange, scoped token reuse, PR analysis and check publication, denied-token recovery${durable ? ", durable worker retry, pre-write SIGKILL recovery in a fresh container, same-scope FIFO, independent-scope progress, reauthentication, completed-delivery deduplication, database-outage HTTP 503 and late-commit recovery, bounded database readiness with independent liveness and recovery" : ""}, graceful SIGTERM and cleanup.`);
