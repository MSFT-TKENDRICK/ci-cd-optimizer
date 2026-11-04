import type { AnyRule } from "../../types.js";
import ghcr from "./ghcr.js";
import githubNpm from "./github-npm.js";

export const rules: AnyRule[] = [ghcr, githubNpm];
