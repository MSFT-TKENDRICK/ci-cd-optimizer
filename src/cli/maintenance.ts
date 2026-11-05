import { parseArgs } from "node:util";
import { validateMaintenanceRequest } from "../knowledge/maintenance.js";
import type { KnowledgeMaintenanceRequest } from "../knowledge/types.js";
import { UsageError, type CliIO } from "./io.js";
import { usingKnowledgeStore } from "./knowledge-store.js";

export const MAINTENANCE_HELP = `Usage: ci-cd-optimizer maintenance <prune|purge> --host <HTTPS-origin> --repository-id <stable-id> [options]

Operator-only access using DATABASE_URL, not a GitHub token. Preview is the default.
  prune     Remove old, unreferenced knowledge; requires --before <YYYY-MM-DDTHH:mm:ss.sssZ>
  purge     Remove repository knowledge and applications of its definitions (including other targets)

To apply a reviewed preview: --apply --confirm <preview-digest> --writers-paused
Stop all App workers and scheduled/CLI knowledge writers first. Changed plans fail without deleting anything.
Prune preserves whole logical runs referenced by events/evaluations, all mitigation history, and referenced topology.
Neither mode removes legacy telemetry, webhook jobs, backups, logs, exports or GitHub items.
No automatic retention or deletion on uninstall is enabled.
`;

export async function maintenanceCommand(args: string[], io: CliIO): Promise<number> {
  const [mode, ...rest] = args;
  if (!mode || mode === "--help" || mode === "-h") { io.stdout(MAINTENANCE_HELP); return 0; }
  if (mode !== "prune" && mode !== "purge") throw new UsageError("Maintenance requires prune or purge.");
  const { values } = parseArgs({
    args: rest, strict: true, options: {
      host: { type: "string" }, "repository-id": { type: "string" }, before: { type: "string" },
      apply: { type: "boolean", default: false }, confirm: { type: "string" },
      "writers-paused": { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { io.stdout(MAINTENANCE_HELP); return 0; }
  if (values.apply && (!values.confirm || !values["writers-paused"])) {
    throw new UsageError("Applying maintenance requires --confirm <preview-digest> and --writers-paused.");
  }
  if (!values.apply && (values.confirm !== undefined || values["writers-paused"])) {
    throw new UsageError("--confirm and --writers-paused require --apply; omit all three for preview.");
  }
  const request: KnowledgeMaintenanceRequest = {
    host: values.host ?? "", repositoryId: values["repository-id"] ?? "", mode,
    ...(values.before !== undefined ? { before: values.before } : {}),
    ...(values.confirm !== undefined ? { confirmation: values.confirm } : {}),
  };
  try { validateMaintenanceRequest(request); }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error }); }
  const result = await usingKnowledgeStore(io, true, async (factory) => (await factory!()).maintain(request), { initialize: false });
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}
