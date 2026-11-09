import type { AnyRule } from "../../types.js";
import bazelMissingVersionPin from "./bazel-missing-version-pin.js";
import goModMutableOverride from "./go-mod-mutable-override.js";
import gradleBuildCacheDisabled from "./gradle-build-cache-disabled.js";
import gradleConfigurationCacheDisabled from "./gradle-configuration-cache-disabled.js";
import gradleParallelDisabled from "./gradle-parallel-disabled.js";
import pythonPipNoHashCheck from "./python-pip-no-hash-check.js";
import rustCargoIncrementalInCi from "./rust-cargo-incremental-in-ci.js";
import rustMissingLockedFlag from "./rust-missing-locked-flag.js";
import rustToolchainUnpinned from "./rust-toolchain-unpinned.js";
import uvSyncUnlocked from "./uv-sync-unlocked.js";

export const rules: AnyRule[] = [
  gradleBuildCacheDisabled,
  gradleConfigurationCacheDisabled,
  gradleParallelDisabled,
  bazelMissingVersionPin,
  rustMissingLockedFlag,
  rustCargoIncrementalInCi,
  goModMutableOverride,
  pythonPipNoHashCheck,
  uvSyncUnlocked,
  rustToolchainUnpinned,
];
