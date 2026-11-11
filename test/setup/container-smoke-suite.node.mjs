import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runSmokeSuite } from "../service/container-smoke-suite.mjs";

function fixture() {
  const children = [];
  const env = { PATH: "tools", SMOKE_DATABASE_URL: "postgres://test", SMOKE_DATABASE_CONTAINER: "test-db", SMOKE_DATABASE_EXTRA: "durable-only" };
  const options = {
    env, log: () => {},
    launch: (command, args, settings) => {
      const child = new EventEmitter();
      children.push({ child, command, args, settings });
      return child;
    },
  };
  return { children, env, options };
}

test("smoke modes start together, isolate database configuration and both must finish", async () => {
  const { children, env, options } = fixture();
  let finished = false;
  const suite = runSmokeSuite(options).finally(() => { finished = true; });
  assert.equal(children.length, 2);
  assert.deepEqual(children[0].settings.env, { PATH: "tools" });
  assert.equal(children[1].settings.env, env);
  assert.equal(children[0].command, process.execPath);
  assert.deepEqual(children[0].args, children[1].args);
  children[0].child.emit("close", 0, null);
  await Promise.resolve();
  assert.equal(finished, false);
  children[1].child.emit("close", 0, null);
  await suite;
});

test("a failed worker does not abandon the other worker's cleanup", async () => {
  const { children, options } = fixture();
  let finished = false;
  const suite = runSmokeSuite(options).finally(() => { finished = true; });
  const rejected = assert.rejects(suite, (error) => error instanceof AggregateError && error.errors.length === 2);
  children[0].child.emit("close", 1, null);
  await Promise.resolve();
  assert.equal(finished, false);
  children[1].child.emit("error", new Error("Spawn failed"));
  children[1].child.emit("close", -1, null);
  await rejected;
});

test("missing durable configuration fails rather than silently testing direct mode twice", async () => {
  const { children, options } = fixture();
  delete options.env.SMOKE_DATABASE_CONTAINER;
  await assert.rejects(runSmokeSuite(options), /disposable/);
  assert.equal(children.length, 0);
});
