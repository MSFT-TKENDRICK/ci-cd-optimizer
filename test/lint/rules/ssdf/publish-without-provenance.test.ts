import rule from "../../../../src/lint/rules/ssdf/publish-without-provenance.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    { name: "non-publishing job is ignored", files: "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n" },
    {
      name: "attestation in the publishing job is evidence",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push ghcr.io/example/app:latest\n      - uses: actions/attest-build-provenance@0123456789012345678901234567890123456789\n",
    },
    {
      name: "build push action with explicit provenance is evidence",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@0123456789012345678901234567890123456789\n        with:\n          push: true\n          provenance: true\n",
    },
  ],
  invalid: [
    {
      name: "docker push without visible provenance",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push ghcr.io/example/app:latest\n",
      errors: [{ path: ".github/workflows/ci.yml", messageIncludes: "no recognized provenance" }],
    },
    {
      name: "build push action publishes when push is true",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@0123456789012345678901234567890123456789\n        with:\n          push: true\n",
      errors: 1,
    },
  ],
});
