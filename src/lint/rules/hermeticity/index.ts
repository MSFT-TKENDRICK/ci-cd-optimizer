import type { AnyRule } from "../../types.js";
import actionsLock from "./actions-lock.js";
import dockerBaseDigest from "./docker-base-digest.js";
import frozenLockfile from "./frozen-lockfile.js";
import pinActions from "./pin-actions.js";
import pinContainerImages from "./pin-container-images.js";
import pinRunner from "./pin-runner.js";

export const rules: AnyRule[] = [actionsLock, dockerBaseDigest, frozenLockfile, pinActions, pinContainerImages, pinRunner];
