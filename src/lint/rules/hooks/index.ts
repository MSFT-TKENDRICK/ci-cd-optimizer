import installInHook from "./install-in-hook.js";
import preCommitRepoScan from "./pre-commit-repo-scan.js";

export const rules = [installInHook, preCommitRepoScan];
