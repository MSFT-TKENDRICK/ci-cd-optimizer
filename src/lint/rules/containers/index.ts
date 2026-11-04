import type { AnyRule } from "../../types.js";
import aptHygiene from "./apt-hygiene.js";
import cacheMount from "./cache-mount.js";
import dependencyLayer from "./dependency-layer.js";
import dockerignore from "./dockerignore.js";
import multiStage from "./multi-stage.js";
import sharedBase from "./shared-base.js";

export const rules: AnyRule[] = [aptHygiene, cacheMount, dependencyLayer, dockerignore, multiStage, sharedBase];