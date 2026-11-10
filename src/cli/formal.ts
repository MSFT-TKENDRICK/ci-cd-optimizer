import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { checkCertificate, createCacheCertificate, createCiPlanCertificate, createDecisionCertificate } from "../formal/certificate.js";
import { canonicalJson, parseStrictJson, string } from "../formal/json.js";
import { readCommittedBlob } from "../formal/source.js";
import { resolvePath, UsageError, writeText, type CliIO } from "./io.js";
import { searchBudgetOption } from "./ci-plan.js";

export const FORMAL_HELP = `Usage:
  ci-cd-optimizer formal cache-key --commit <full-sha> --path <git-path> --job <id> --step <0-based>
      [--source <repository>] [--dependencies <json-array-file>] [--output <certificate.json>]
  ci-cd-optimizer formal decision --commit <full-sha> --manifest <git-path> --config <git-path>
      --measurements <git-path> --at <YYYY-MM-DDTHH:mm:ss.sssZ> [--source <repository>] [--output <certificate.json>]
  ci-cd-optimizer formal ci-plan --commit <full-sha> --path <ci-environment.json>
      [--search-budget <policies>] [--source <repository>] [--output <certificate.json>]
  ci-cd-optimizer formal check <certificate.json> [--source <repository>]

Creation reads immutable commit:path blobs, not working files. Dependencies omitted means the explicitly
labeled inference policy (key components except SHA/run counters); it is not workload dependency discovery.
Checking without --source validates only the embedded model data. A digest is not a signature.
CI planning binds the model input only, not its correspondence to any workflow. Certificate validity
does not imply an optimal result: inspect resultStatus (optimal, infeasible, or budget-exhausted).
Exit codes: 0 source-bound-valid; 3 model-valid without source binding; 1 invalid; 2 usage.
See docs/formal-verification.md for the precise model, numeric bounds, assumptions and proof commands.`;

const text = async (path: string) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));

export async function formalCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") { io.stdout(FORMAL_HELP); return 0; }
  if (command === "check") {
    const { values, positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { source: { type: "string" } } });
    const file = positionals[0];
    if (!file || positionals.length !== 1) throw new UsageError("formal check requires one certificate file.");
    const result = await checkCertificate(await text(resolvePath(io, file)), values.source === undefined ? undefined : resolvePath(io, values.source));
    io.stdout(canonicalJson(result));
    return result.status === "source-bound-valid" ? 0 : 3;
  }
  if (command !== "cache-key" && command !== "decision" && command !== "ci-plan") throw new UsageError(`Unknown formal command: ${command}`);
  const { values }: { values: Record<string, unknown> } = parseArgs({
    args: rest, strict: true,
    options: {
      source: { type: "string" }, commit: { type: "string" }, output: { type: "string" },
      ...(command === "cache-key"
        ? { path: { type: "string" }, job: { type: "string" }, step: { type: "string" }, dependencies: { type: "string" } }
        : command === "decision"
          ? { manifest: { type: "string" }, config: { type: "string" }, measurements: { type: "string" }, at: { type: "string" } }
          : { path: { type: "string" }, "search-budget": { type: "string" } }),
    },
  });
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string" || !value) throw new UsageError(`formal ${command} requires --${name}.`);
    return value;
  };
  const repository = resolvePath(io, typeof values.source === "string" ? values.source : ".");
  const commit = required("commit");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new UsageError("--commit must be a full lowercase Git commit id.");
  let certificate: ReturnType<typeof createCacheCertificate> | ReturnType<typeof createDecisionCertificate> | ReturnType<typeof createCiPlanCertificate>;
  if (command === "cache-key") {
    const stepText = required("step");
    const step = Number(stepText);
    if (!/^(?:0|[1-9]\d*)$/.test(stepText) || !Number.isSafeInteger(step)) throw new UsageError("--step must be a nonnegative integer.");
    let dependencies: string[] | null = null;
    if (typeof values.dependencies === "string") {
      const parsed = parseStrictJson(await text(resolvePath(io, values.dependencies)));
      if (!Array.isArray(parsed)) throw new UsageError("--dependencies must name a JSON array of expression strings.");
      dependencies = parsed.map((entry) => string(entry, "dependency"));
    }
    certificate = createCacheCertificate(await readCommittedBlob(repository, commit, required("path")), required("job"), step, dependencies);
  } else if (command === "decision") {
    const at = required("at");
    const date = new Date(at);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== at) throw new UsageError("--at must be a canonical UTC ISO timestamp with milliseconds.");
    const [manifest, config, measurements] = await Promise.all(["manifest", "config", "measurements"].map((key) => readCommittedBlob(repository, commit, required(key))));
    if (!manifest || !config || !measurements) throw new Error("Missing committed decision source.");
    certificate = createDecisionCertificate({ manifest, config, measurements }, at);
  } else {
    certificate = createCiPlanCertificate(
      await readCommittedBlob(repository, commit, required("path")), searchBudgetOption(values["search-budget"]),
    );
  }
  const serialized = canonicalJson(certificate);
  const checked = await checkCertificate(serialized, repository);
  await writeText(io, typeof values.output === "string" ? values.output : undefined, serialized);
  io.stderr(`source-bound-valid: checked against recorded Git blobs; evidence authenticity and real-world performance are not attested.${checked.resultStatus ? ` Model outcome: ${checked.resultStatus}; workflow correspondence remains an assumption.` : ""}`);
  return 0;
}
