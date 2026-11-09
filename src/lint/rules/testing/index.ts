import type { AnyRule } from "../../types.js";
import cacheDisabledInstall from "./cache-disabled-install.js";
import fixedSleep from "./fixed-sleep.js";
import maskedFailures from "./masked-failures.js";
import playwrightBrowserCache from "./playwright-browser-cache.js";
import toolIncrementalCache from "./tool-incremental-cache.js";
import unconditionalDebugUpload from "./unconditional-debug-upload.js";
import watchModeInCi from "./watch-mode-in-ci.js";

export const rules: AnyRule[] = [
  playwrightBrowserCache,
  toolIncrementalCache,
  watchModeInCi,
  unconditionalDebugUpload,
  maskedFailures,
  cacheDisabledInstall,
  fixedSleep,
];
