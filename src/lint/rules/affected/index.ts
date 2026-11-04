import type { AnyRule } from "../../types.js";
import changeDetection from "./change-detection.js";
import pathFilterRequiredChecks from "./path-filter-required-checks.js";
import testSelection from "./test-selection.js";
import trustedChangeDetection from "./trusted-change-detection.js";

export const rules: AnyRule[] = [changeDetection, pathFilterRequiredChecks, testSelection, trustedChangeDetection];
