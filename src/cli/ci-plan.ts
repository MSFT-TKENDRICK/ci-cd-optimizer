import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CI_MODEL_LIMITS, CI_MODEL_MAX_BYTES, parseCiEnvironmentModel, planCiEnvironment, type CiEnvironmentModel } from "../experiments/plan.js";
import { canonicalJson } from "../formal/json.js";
import { resolvePath, UsageError, writeText, type CliIO } from "./io.js";

export function searchBudgetOption(value: unknown): number {
  if (value === undefined) return CI_MODEL_LIMITS.defaultSearchBudget;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) ||
    Number(value) > CI_MODEL_LIMITS.maxSearchBudget) {
    throw new UsageError(`--search-budget must be an integer in [1, ${CI_MODEL_LIMITS.maxSearchBudget}].`);
  }
  return Number(value);
}

export async function readCiEnvironment(io: CliIO, path: string): Promise<CiEnvironmentModel> {
  const file = await open(resolvePath(io, path), "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("The CI environment must be a regular file.");
    const bytes = Buffer.alloc(CI_MODEL_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > CI_MODEL_MAX_BYTES) throw new Error(`CI environment exceeds the ${CI_MODEL_MAX_BYTES} byte input limit.`);
    return parseCiEnvironmentModel(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
  } finally { await file.close(); }
}

export async function ciPlanCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args, strict: true,
    options: { model: { type: "string" }, "search-budget": { type: "string" }, output: { type: "string" } },
  });
  if (!values.model) throw new UsageError("experiments plan requires --model <ci-environment.json>.");
  const budget = searchBudgetOption(values["search-budget"]);
  const model = await readCiEnvironment(io, values.model);
  const plan = planCiEnvironment(model, { searchBudget: budget });
  await writeText(io, values.output, canonicalJson(plan));
  io.stderr(plan.status === "optimal"
    ? "Optimal within the declared CI model only. Validate this candidate empirically before any promotion; workflow correspondence and timing profiles are assumptions."
    : plan.status === "infeasible"
      ? "No feasible policy exists within the declared model and horizon; the complete policy space was checked."
      : `Search budget exhausted before enumeration: ${plan.search.requiredPolicies} policies require more than the ${budget} policy budget. No optimum or infeasibility claim.`);
  return plan.status === "optimal" ? 0 : plan.status === "infeasible" ? 4 : 5;
}
