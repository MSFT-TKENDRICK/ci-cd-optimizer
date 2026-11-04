import type { AnyRule } from "../../types.js";
import buildToolCache from "./build-tool-cache.js";
import cacheKey from "./cache-key.js";
import dockerLayerCache from "./docker-layer-cache.js";
import setupCache from "./setup-cache.js";

export const rules: AnyRule[] = [buildToolCache, cacheKey, dockerLayerCache, setupCache];
