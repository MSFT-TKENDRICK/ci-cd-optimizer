import { textOf, type ToolResult } from "./transport";
import { isSetupState, type SetupState } from "./types";

// What the model-visible open tool hands the View: the loopback session and the first snapshot.
export interface Boot {
  session: string;
  state: SetupState;
}

export type BootOutcome = { boot: Boot } | { failure: string };

export function parseBootResult(result: ToolResult): BootOutcome {
  if (result.isError) return { failure: textOf(result) || "Setup could not start." };
  const data: { session?: unknown; state?: unknown } = result.structuredContent ?? {};
  if (typeof data.session === "string" && data.session && isSetupState(data.state)) {
    return { boot: { session: data.session, state: data.state } };
  }
  return { failure: "Copilot returned an unexpected setup response." };
}
