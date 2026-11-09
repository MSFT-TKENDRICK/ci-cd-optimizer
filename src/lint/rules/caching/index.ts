import type { AnyRule } from "../../types.js";
import buildToolCache from "./build-tool-cache.js";
import cacheKey from "./cache-key.js";
import dockerLayerCache from "./docker-layer-cache.js";
import matrixCacheKeyMissingOs from "./matrix-cache-key-missing-os.js";
import prBranchCacheSave from "./pr-branch-cache-save.js";
import setupCache from "./setup-cache.js";
import uncompressedArtifactUpload from "./uncompressed-artifact-upload.js";

export const rules: AnyRule[] = [
  buildToolCache,
  cacheKey,
  dockerLayerCache,
  matrixCacheKeyMissingOs,
  prBranchCacheSave,
  setupCache,
  uncompressedArtifactUpload,
];
