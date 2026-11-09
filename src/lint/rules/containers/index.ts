import type { AnyRule } from "../../types.js";
import aptHygiene from "./apt-hygiene.js";
import buildxLoadMultiplatform from "./buildx-load-multiplatform.js";
import cacheMount from "./cache-mount.js";
import curlPipeShell from "./curl-pipe-shell.js";
import dependencyLayer from "./dependency-layer.js";
import dockerNoCacheBuild from "./docker-no-cache-build.js";
import dockerignore from "./dockerignore.js";
import ghaCacheMissingScope from "./gha-cache-missing-scope.js";
import ghaCacheModeMin from "./gha-cache-mode-min.js";
import multiStage from "./multi-stage.js";
import pnpmFetchDockerLayer from "./pnpm-fetch-docker-layer.js";
import qemuEmulatedMultiarch from "./qemu-emulated-multiarch.js";
import runtimeToolInstallVsContainer from "./runtime-tool-install-vs-container.js";
import sharedBase from "./shared-base.js";
import sleepPollingHealthCheck from "./sleep-polling-health-check.js";

export const rules: AnyRule[] = [
  aptHygiene,
  buildxLoadMultiplatform,
  cacheMount,
  curlPipeShell,
  dependencyLayer,
  dockerNoCacheBuild,
  dockerignore,
  ghaCacheMissingScope,
  ghaCacheModeMin,
  multiStage,
  pnpmFetchDockerLayer,
  qemuEmulatedMultiarch,
  runtimeToolInstallVsContainer,
  sharedBase,
  sleepPollingHealthCheck,
];