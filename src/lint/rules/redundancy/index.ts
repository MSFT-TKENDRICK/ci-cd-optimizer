import type { AnyRule } from "../../types.js";
import duplicateCommand from "./duplicate-command.js";
import duplicateSetupStep from "./duplicate-setup-step.js";
import rebuildPerJob from "./rebuild-per-job.js";
import repeatedJobSetup from "./repeated-job-setup.js";
import shadowedEnv from "./shadowed-env.js";
import sourceCliWithCommittedBundle from "./source-cli-with-committed-bundle.js";
import toolchainVersionDrift from "./toolchain-version-drift.js";

export const rules: AnyRule[] = [
  duplicateSetupStep,
  repeatedJobSetup,
  rebuildPerJob,
  duplicateCommand,
  shadowedEnv,
  toolchainVersionDrift,
  sourceCliWithCommittedBundle,
];
