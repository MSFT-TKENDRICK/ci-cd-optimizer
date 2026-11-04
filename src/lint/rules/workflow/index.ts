import type { AnyRule } from "../../types.js";
import artifactRetention from "./artifact-retention.js";
import concurrency from "./concurrency.js";
import jobTimeout from "./job-timeout.js";
import mergeGroup from "./merge-group.js";
import outdatedActionMajor from "./outdated-action-major.js";

export const rules: AnyRule[] = [artifactRetention, concurrency, jobTimeout, mergeGroup, outdatedActionMajor];
