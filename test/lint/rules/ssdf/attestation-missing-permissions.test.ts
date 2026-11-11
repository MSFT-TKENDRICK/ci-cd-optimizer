import rule from "../../../../src/lint/rules/ssdf/attestation-missing-permissions.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "job declares both required permissions",
      files: "on: push\njobs:\n  release:\n    permissions:\n      id-token: write\n      attestations: write\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/attest-build-provenance@0123456789012345678901234567890123456789\n",
    },
    {
      name: "workflow-level permissions are inherited",
      files: "on: push\npermissions:\n  id-token: write\n  attestations: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/attest@0123456789012345678901234567890123456789\n",
    },
    {
      name: "unrelated jobs do not need attestation permissions",
      files: "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
    },
    {
      name: "write-all provides the required scopes",
      files: "on: push\npermissions: write-all\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/attest@0123456789012345678901234567890123456789\n",
    },
  ],
  invalid: [
    {
      name: "default permissions are not relied on",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/attest-build-provenance@0123456789012345678901234567890123456789\n",
      errors: [{ path: ".github/workflows/ci.yml", messageIncludes: "id-token" }],
    },
    {
      name: "job override removes inherited attestation permissions",
      files: "on: push\npermissions:\n  id-token: write\n  attestations: write\njobs:\n  release:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/attest-sbom@0123456789012345678901234567890123456789\n",
      errors: [{ messageIncludes: "id-token" }],
    },
  ],
});
