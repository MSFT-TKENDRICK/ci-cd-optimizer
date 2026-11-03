import { containerRules } from "./containers.js";
import { registryRules } from "./registries.js";
import { workflowRules } from "./workflows.js";

export const rules = [...workflowRules, ...containerRules, ...registryRules];
