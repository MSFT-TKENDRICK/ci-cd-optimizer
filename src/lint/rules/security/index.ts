import type { AnyRule } from "../../types.js";
import envFileInjection from "./env-file-injection.js";
import excessivePermissions from "./excessive-permissions.js";
import expressionInjection from "./expression-injection.js";
import installScriptsPrivileged from "./install-scripts-privileged.js";
import mutableRemoteRef from "./mutable-remote-ref.js";
import persistedCredentials from "./persisted-credentials.js";
import privilegedCacheRestore from "./privileged-cache-restore.js";
import secretsBulkExpose from "./secrets-bulk-expose.js";
import untrustedCheckout from "./untrusted-checkout.js";

export const rules: AnyRule[] = [
  envFileInjection,
  excessivePermissions,
  expressionInjection,
  installScriptsPrivileged,
  mutableRemoteRef,
  persistedCredentials,
  privilegedCacheRestore,
  secretsBulkExpose,
  untrustedCheckout,
];
