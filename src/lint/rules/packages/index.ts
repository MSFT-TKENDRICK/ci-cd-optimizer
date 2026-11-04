import type { AnyRule } from "../../types.js";
import exportsMap from "./exports-map.js";
import filesAllowlist from "./files-allowlist.js";
import monolith from "./monolith.js";
import versionDrift from "./version-drift.js";

export const rules: AnyRule[] = [exportsMap, filesAllowlist, monolith, versionDrift];