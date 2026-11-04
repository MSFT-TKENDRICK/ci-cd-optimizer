import type { AnyRule } from "../types.js";
import { rules as affected } from "./affected/index.js";
import { rules as caching } from "./caching/index.js";
import { rules as checkout } from "./checkout/index.js";
import { rules as containers } from "./containers/index.js";
import { rules as hermeticity } from "./hermeticity/index.js";
import { rules as packages } from "./packages/index.js";
import { rules as registries } from "./registries/index.js";
import { rules as workflow } from "./workflow/index.js";

export const RULESETS = ["workflow", "checkout", "affected", "caching", "hermeticity", "containers", "packages", "registries"] as const;

export const allRules: AnyRule[] = [
  ...workflow,
  ...checkout,
  ...affected,
  ...caching,
  ...hermeticity,
  ...containers,
  ...packages,
  ...registries,
];
