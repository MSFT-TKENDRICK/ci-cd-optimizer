import type { AnyRule } from "../../types.js";
import artifactRetention from "./artifact-retention.js";
import concurrency from "./concurrency.js";
import duplicatePushPullRequestTrigger from "./duplicate-push-pull-request-trigger.js";
import jobTimeout from "./job-timeout.js";
import largerRunnerUnjustified from "./larger-runner-unjustified.js";
import matrixExplosion from "./matrix-explosion.js";
import mergeGroup from "./merge-group.js";
import outdatedActionMajor from "./outdated-action-major.js";
import setupActionMissingVersionFile from "./setup-action-missing-version-file.js";
import unnecessaryNeedsSerialization from "./unnecessary-needs-serialization.js";

export const rules: AnyRule[] = [
  artifactRetention,
  concurrency,
  duplicatePushPullRequestTrigger,
  jobTimeout,
  largerRunnerUnjustified,
  matrixExplosion,
  mergeGroup,
  outdatedActionMajor,
  setupActionMissingVersionFile,
  unnecessaryNeedsSerialization,
];
