import { spawn } from "node:child_process";
import console from "node:console";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const worker = fileURLToPath(new URL("./container-smoke.mjs", import.meta.url));

export async function runSmokeSuite({ env = process.env, launch = spawn, log = console.log } = {}) {
  if (!env.SMOKE_DATABASE_URL || !env.SMOKE_DATABASE_CONTAINER) {
    throw new Error("The smoke suite requires a disposable SMOKE_DATABASE_URL and SMOKE_DATABASE_CONTAINER.");
  }
  const direct = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("SMOKE_DATABASE_")));
  const started = performance.now();
  const results = await Promise.allSettled([["direct", direct], ["postgres", env]].map(([mode, childEnv]) =>
    new Promise((resolve, reject) => {
      const start = performance.now();
      const child = launch(process.execPath, [worker], { env: childEnv, stdio: "inherit", windowsHide: true });
      let failure;
      child.once("error", (error) => { failure = error; });
      child.once("close", (code, signal) => {
        log(`Container smoke ${mode}: ${Math.round(performance.now() - start)} ms; exit=${code}; signal=${signal ?? "none"}`);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Container smoke ${mode} failed (exit=${code}, signal=${signal ?? "none"}).`));
        else resolve();
      });
    })));
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  log(`Container smoke suite: ${Math.round(performance.now() - started)} ms; both configurations settled.`);
  if (failures.length) throw new AggregateError(failures, "Container smoke suite failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSmokeSuite();
