import type { AnyRule } from "../../types.js";
import affectedBaseRef from "./affected-base-ref.js";
import partialClone from "./partial-clone.js";
import sparseCheckout from "./sparse-checkout.js";

export const rules: AnyRule[] = [affectedBaseRef, partialClone, sparseCheckout];
