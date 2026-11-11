import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { once } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const startupTimeout = 30_000;
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: startupTimeout,
}).trim();

function saveResult(directory, result) {
  writeFileSync(join(directory, "result.tmp"), JSON.stringify(result), { flag: "wx" });
  renameSync(join(directory, "result.tmp"), join(directory, "result.json"));
}

export async function startDatabase({ directory, name }, launch = spawn) {
  mkdirSync(directory);
  writeFileSync(join(directory, "started.json"), JSON.stringify({ at: Date.now() }), { flag: "wx" });
  const log = openSync(join(directory, "start.log"), "wx");
  try {
    // The whole command must be backgrounded: Docker's --detach still waits for the image pull.
    const child = launch(process.execPath, [script, "worker"], {
      env: { ...process.env, SMOKE_DATABASE_CONTAINER: name },
      detached: true, stdio: ["ignore", log, log], windowsHide: true,
    });
    await once(child, "spawn");
    child.unref();
  } catch (error) {
    saveResult(directory, { ok: false, error: String(error) });
    throw error;
  } finally {
    closeSync(log);
  }
}

export function finishDatabaseStart({ directory, name, run = docker }) {
  const started = Date.now();
  let id;
  try {
    id = run("run", "--detach", "--name", name,
      "--env", "POSTGRES_PASSWORD=postgres",
      "--health-cmd", "pg_isready -U postgres", "--health-interval", "2s",
      "--health-timeout", "5s", "--health-retries", "15", "postgres:17.6");
    assert.match(id, /^[a-f0-9]{64}$/, "Docker did not return a container ID");
  } catch (error) {
    saveResult(directory, { ok: false, error: String(error) });
    throw error;
  }
  saveResult(directory, { ok: true, id, durationMs: Date.now() - started });
}

async function startupResult({ directory, pause = setTimeout, now = Date.now }) {
  const { at } = JSON.parse(readFileSync(join(directory, "started.json"), "utf8"));
  assert.ok(Number.isFinite(at), "Missing startup timestamp");
  for (;;) {
    try {
      const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
      assert.equal(typeof result.ok, "boolean", "Invalid startup result");
      if (result.ok) {
        assert.match(result.id, /^[a-f0-9]{64}$/);
        assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
      } else {
        assert.equal(typeof result.error, "string", "Missing startup error");
      }
      return result;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (now() - at >= startupTimeout + 5_000) throw new Error("PostgreSQL startup worker did not report within 35 seconds.");
    await pause(100);
  }
}

export async function waitForDatabase(context) {
  const { name, run = docker, pause = setTimeout, now = Date.now, log = console.log } = context;
  const result = await startupResult(context);
  assert.ok(result.ok, `PostgreSQL startup failed: ${result.error}`);
  const started = now();
  // Retain Docker's health policy, with an outer bound for a missing/stalled health check.
  while (now() - started < 110_000) {
    const state = JSON.parse(run("inspect", "--format", "{{json .State}}", result.id));
    assert.equal(state.Running, true, "PostgreSQL exited before smoke tests");
    assert.ok(state.Health?.Status === "starting" || state.Health?.Status === "healthy",
      `PostgreSQL is not healthy: ${JSON.stringify(state.Health)}`);
    if (state.Health.Status === "healthy") {
      log(`PostgreSQL ready: ${name}; startup=${result.durationMs} ms; readiness wait=${now() - started} ms`);
      return;
    }
    await pause(2000);
  }
  throw new Error("PostgreSQL health checks did not settle within 110 seconds.");
}

export async function removeDatabase(context) {
  const { name, run = docker, log = console.log } = context;
  let result;
  const failures = [];
  // Normally join startup first. Missing/corrupt results still require removal, but cannot certify cleanup.
  try {
    result = await startupResult(context);
    assert.ok(result.ok, `PostgreSQL startup failed: ${result.error}`);
  } catch (error) {
    failures.push(error);
  }
  try {
    const id = run("container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`);
    if (id) {
      assert.match(id, /^[a-f0-9]{64}$/);
      run("rm", "--force", "--volumes", id);
      assert.equal(run("container", "ls", "--all", "--quiet", "--filter", `name=^/${name}$`), "",
        "PostgreSQL container survived cleanup");
    } else if (result?.ok) {
      throw new Error("The started PostgreSQL container disappeared before cleanup");
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "PostgreSQL startup and cleanup both failed");
  log(`PostgreSQL removed: ${name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const name = process.env.SMOKE_DATABASE_CONTAINER;
    assert.match(name ?? "", /^cicd-smoke-postgres-\d+-\d+$/);
    assert.ok(process.env.RUNNER_TEMP, "RUNNER_TEMP is required");
    const context = { name, directory: join(process.env.RUNNER_TEMP, name) };
    const commands = { start: startDatabase, worker: finishDatabaseStart, ready: waitForDatabase, cleanup: removeDatabase };
    assert.ok(Object.hasOwn(commands, process.argv[2]), "Expected start, worker, ready or cleanup");
    await commands[process.argv[2]](context);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
