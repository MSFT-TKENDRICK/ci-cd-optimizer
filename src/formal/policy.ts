import { BigNumber } from "bignumber.js";
import type { Severity } from "../lint/types.js";
import { Dafny, Policy } from "./generated/kernel.js";

const LEVELS: readonly Severity[] = ["off", "info", "warn", "error"];

/** Last non-absent severity assignment wins. Options, preset membership and YAML parsing are not proved here. */
export function resolveSeverity(updates: Array<Severity | undefined>): Severity {
  const encoded = updates.map((level) => {
    const index = level === undefined ? -1 : LEVELS.indexOf(level);
    if (level !== undefined && index < 0) throw new Error(`Unknown severity: ${String(level)}`);
    return new BigNumber(index);
  });
  const result: number = Policy.__default.Resolve(Dafny.Seq.of(...encoded)).toNumber();
  const severity = LEVELS[result];
  if (severity === undefined) throw new Error("Unexpected generated policy result.");
  return severity;
}
