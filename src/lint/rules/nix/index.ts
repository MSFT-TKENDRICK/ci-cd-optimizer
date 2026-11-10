import type { AnyRule } from "../../types.js";
import acceptFlakeConfigUntrusted from "./accept-flake-config-untrusted.js";
import builtinsFetchurlUnverified from "./builtins-fetchurl-unverified.js";
import channelInCi from "./channel-in-ci.js";
import currentSystemBuiltin from "./current-system-builtin.js";
import devShellReinvokedPerStep from "./dev-shell-reinvoked-per-step.js";
import dockertoolsSingleLayerImage from "./dockertools-single-layer-image.js";
import duplicateNixpkgsNodes from "./duplicate-nixpkgs-nodes.js";
import fakeHashCommitted from "./fake-hash-committed.js";
import fetchgitMissingRev from "./fetchgit-missing-rev.js";
import fetchtarballNoHash from "./fetchtarball-no-hash.js";
import flakeCheckMissingParallelEvaluator from "./flake-check-missing-parallel-evaluator.js";
import flakeLockMissingInput from "./flake-lock-missing-input.js";
import flakeNixconfigCacheNotTrusted from "./flake-nixconfig-cache-not-trusted.js";
import flakeUpdateInBuildJob from "./flake-update-in-build-job.js";
import getEnvBuiltin from "./get-env-builtin.js";
import gitInputForGithub from "./git-input-for-github.js";
import imperativeInstall from "./imperative-install.js";
import importFromDerivation from "./import-from-derivation.js";
import impureFlagInCi from "./impure-flag-in-ci.js";
import indirectInput from "./indirect-input.js";
import installerUnpinnedNixVersion from "./installer-unpinned-nix-version.js";
import maxJobsPinnedLow from "./max-jobs-pinned-low.js";
import missingFlakeLock from "./missing-flake-lock.js";
import nixBuildInsideDocker from "./nix-build-inside-docker.js";
import nixShellDashPUnpinned from "./nix-shell-dash-p-unpinned.js";
import nixpkgsAngleBracketPath from "./nixpkgs-angle-bracket-path.js";
import nixpkgsInputNotChannel from "./nixpkgs-input-not-channel.js";
import noBinaryCacheConfigured from "./no-binary-cache-configured.js";
import noLockUpdateAutomation from "./no-lock-update-automation.js";
import outdatedMagicNixCache from "./outdated-magic-nix-cache.js";
import overlayOverridesFoundationalPackage from "./overlay-overrides-foundational-package.js";
import quickInstallImplicitFlakeConfigTrust from "./quick-install-implicit-flake-config-trust.js";
import rawStoreCache from "./raw-store-cache.js";
import rustTwoPhaseBuild from "./rust-two-phase-build.js";
import sandboxDisabled from "./sandbox-disabled.js";
import separateNixBuildInvocations from "./separate-nix-build-invocations.js";
import srcWholeRepo from "./src-whole-repo.js";

export const rules: AnyRule[] = [
  acceptFlakeConfigUntrusted,
  builtinsFetchurlUnverified,
  channelInCi,
  currentSystemBuiltin,
  devShellReinvokedPerStep,
  dockertoolsSingleLayerImage,
  duplicateNixpkgsNodes,
  fakeHashCommitted,
  fetchgitMissingRev,
  fetchtarballNoHash,
  flakeCheckMissingParallelEvaluator,
  flakeLockMissingInput,
  flakeNixconfigCacheNotTrusted,
  flakeUpdateInBuildJob,
  getEnvBuiltin,
  gitInputForGithub,
  imperativeInstall,
  importFromDerivation,
  impureFlagInCi,
  indirectInput,
  installerUnpinnedNixVersion,
  maxJobsPinnedLow,
  missingFlakeLock,
  nixBuildInsideDocker,
  nixShellDashPUnpinned,
  nixpkgsAngleBracketPath,
  nixpkgsInputNotChannel,
  noBinaryCacheConfigured,
  noLockUpdateAutomation,
  outdatedMagicNixCache,
  overlayOverridesFoundationalPackage,
  quickInstallImplicitFlakeConfigTrust,
  rawStoreCache,
  rustTwoPhaseBuild,
  sandboxDisabled,
  separateNixBuildInvocations,
  srcWholeRepo,
];
