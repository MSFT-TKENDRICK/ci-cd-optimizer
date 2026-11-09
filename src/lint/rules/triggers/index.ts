import type { AnyRule } from "../../types.js";
import draftPrGating from "./draft-pr-gating.js";
import frequentSchedule from "./frequent-schedule.js";
import missingJobConditionMatrix from "./missing-job-condition-matrix.js";
import noisyPrTypes from "./noisy-pr-types.js";
import serializedMatrix from "./serialized-matrix.js";
import shardFailFast from "./shard-fail-fast.js";
import workflowRunChain from "./workflow-run-chain.js";

export const rules: AnyRule[] = [
  workflowRunChain,
  serializedMatrix,
  draftPrGating,
  noisyPrTypes,
  frequentSchedule,
  shardFailFast,
  missingJobConditionMatrix,
];
