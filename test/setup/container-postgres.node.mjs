import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextTick } from "node:process";
import { test } from "node:test";
import { finishDatabaseStart, removeDatabase, startDatabase, waitForDatabase } from "../service/container-postgres.mjs";

const id = "a".repeat(64);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cicd-postgres-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "state");
  return { directory, name: "cicd-smoke-postgres-123-1", log: () => {} };
}
function started(context) {
  mkdirSync(context.directory);
  writeFileSync(join(context.directory, "started.json"), JSON.stringify({ at: Date.now() }));
}

test("startup returns while its detached worker continues", async (t) => {
  const context = fixture(t);
  let detached = false;
  await startDatabase(context, (command, args, settings) => {
    assert.equal(command, process.execPath);
    assert.equal(args.at(-1), "worker");
    assert.equal(settings.detached, true);
    assert.equal(settings.env.SMOKE_DATABASE_CONTAINER, context.name);
    const child = new EventEmitter();
    child.unref = () => { detached = true; };
    nextTick(() => child.emit("spawn"));
    return child;
  });
  assert.equal(detached, true);
  assert.throws(() => readFileSync(join(context.directory, "result.json")), { code: "ENOENT" });
});

test("startup retains health policy and readiness gates smoke before cleanup joins it", async (t) => {
  const context = fixture(t);
  started(context);
  finishDatabaseStart({ ...context, run: (...args) => {
    assert.deepEqual(args, ["run", "--detach", "--name", context.name, "--env", "POSTGRES_PASSWORD=postgres",
      "--health-cmd", "pg_isready -U postgres", "--health-interval", "2s", "--health-timeout", "5s",
      "--health-retries", "15", "postgres:17.6"]);
    return id;
  } });
  let inspections = 0;
  let pauses = 0;
  await waitForDatabase({ ...context, run: (...args) => {
    assert.deepEqual(args, ["inspect", "--format", "{{json .State}}", id]);
    return JSON.stringify({ Running: true, Health: { Status: inspections++ ? "healthy" : "starting" } });
  }, pause: async () => { pauses++; } });
  assert.equal(pauses, 1);
  let removed = false;
  await removeDatabase({ ...context, run: (...args) => {
    if (args[0] === "rm") {
      assert.deepEqual(args, ["rm", "--force", "--volumes", id]);
      removed = true;
      return id;
    }
    assert.equal(args.at(-1), `name=^/${context.name}$`);
    return removed ? "" : id;
  } });
  assert.equal(removed, true);
});

test("worker failures are persisted, reject readiness and still remove a partially created container", async (t) => {
  const context = fixture(t);
  started(context);
  assert.throws(() => finishDatabaseStart({ ...context, run: () => { throw new Error("pull failed"); } }), /pull failed/);
  await assert.rejects(waitForDatabase(context), /pull failed/);
  let removed = false;
  await assert.rejects(removeDatabase({ ...context, run: (...args) => {
    if (args[0] === "rm") { removed = true; return id; }
    return removed ? "" : id;
  } }), /pull failed/);
  assert.equal(removed, true);
});

test("unhealthy or stopped databases fail closed", async (t) => {
  const context = fixture(t);
  started(context);
  finishDatabaseStart({ ...context, run: () => id });
  for (const state of [{ Running: false }, { Running: true, Health: { Status: "unhealthy" } }]) {
    await assert.rejects(waitForDatabase({ ...context, run: () => JSON.stringify(state) }), /before smoke|not healthy/);
  }
});

test("a missing worker result times out and corrupt evidence is never treated as success", async (t) => {
  const context = fixture(t);
  started(context);
  await assert.rejects(waitForDatabase({ ...context, now: () => Date.now() + 35_000 }), /did not report/);
  writeFileSync(join(context.directory, "result.json"), '{"ok":true}');
  await assert.rejects(waitForDatabase(context));
});

test("a spawn failure is recorded instead of leaving an apparently running worker", async (t) => {
  const context = fixture(t);
  await assert.rejects(startDatabase(context, () => {
    const child = new EventEmitter();
    nextTick(() => child.emit("error", new Error("spawn failed")));
    return child;
  }), /spawn failed/);
  await assert.rejects(waitForDatabase(context), /spawn failed/);
});

test("a health check that never settles has a bounded wait", async (t) => {
  const context = fixture(t);
  started(context);
  finishDatabaseStart({ ...context, run: () => id });
  let clock = 0;
  await assert.rejects(waitForDatabase({ ...context,
    run: () => JSON.stringify({ Running: true, Health: { Status: "starting" } }),
    now: () => clock, pause: async (ms) => { clock += ms; },
  }), /did not settle/);
  assert.equal(clock, 110_000);
});

test("cleanup errors cannot be reported as a successful removal", async (t) => {
  const context = fixture(t);
  started(context);
  finishDatabaseStart({ ...context, run: () => id });
  await assert.rejects(removeDatabase({ ...context, run: () => id }), /survived cleanup/);
});

test("cleanup waits for a delayed startup result before searching for its container", async (t) => {
  const context = fixture(t);
  started(context);
  let finished = false;
  let removed = false;
  await removeDatabase({ ...context, pause: async () => {
    finishDatabaseStart({ ...context, run: () => id });
    finished = true;
  }, run: (...args) => {
    assert.equal(finished, true);
    if (args[0] === "rm") { removed = true; return id; }
    return removed ? "" : id;
  } });
  assert.equal(removed, true);
});

test("cleanup removes a known container despite a missing startup result and preserves the timeout", async (t) => {
  const context = fixture(t);
  started(context);
  let removed = false;
  const messages = [];
  await assert.rejects(removeDatabase({ ...context, now: () => Date.now() + 35_000,
    log: (message) => messages.push(message), run: (...args) => {
      if (args[0] === "rm") { removed = true; return id; }
      return removed ? "" : id;
    },
  }), /did not report/);
  assert.equal(removed, true);
  assert.deepEqual(messages, []);
});

test("corrupt startup evidence cannot prevent removal or become a success", async (t) => {
  const context = fixture(t);
  started(context);
  writeFileSync(join(context.directory, "result.json"), '{"ok":true}');
  let removed = false;
  await assert.rejects(removeDatabase({ ...context, run: (...args) => {
    if (args[0] === "rm") { removed = true; return id; }
    return removed ? "" : id;
  } }));
  assert.equal(removed, true);
});

test("startup and removal failures are both retained", async (t) => {
  const context = fixture(t);
  started(context);
  for (const expected of [/did not report/, /pull failed/]) {
    await assert.rejects(removeDatabase({ ...context, now: () => Date.now() + 35_000,
      run: () => { throw new Error("Docker daemon unavailable"); },
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, expected);
      assert.match(error.errors[1].message, /Docker daemon unavailable/);
      return true;
    });
    if (expected.source === "did not report") {
      assert.throws(() => finishDatabaseStart({ ...context, run: () => { throw new Error("pull failed"); } }), /pull failed/);
    }
  }
});
