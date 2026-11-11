import type { AnyRule } from "../../types.js";
import attestationMissingPermissions from "./attestation-missing-permissions.js";
import publishWithoutProvenance from "./publish-without-provenance.js";
import publishWithoutSbom from "./publish-without-sbom.js";
import staticCloudCredentials from "./static-cloud-credentials.js";

export const rules: AnyRule[] = [
  attestationMissingPermissions,
  publishWithoutProvenance,
  publishWithoutSbom,
  staticCloudCredentials,
];
