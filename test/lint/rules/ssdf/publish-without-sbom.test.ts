import rule from "../../../../src/lint/rules/ssdf/publish-without-sbom.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    { name: "non-publishing job is ignored", files: "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n" },
    {
      name: "SBOM generation in the publishing job is evidence",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push ghcr.io/example/app:latest\n      - uses: anchore/sbom-action@0123456789012345678901234567890123456789\n",
    },
  ],
  invalid: [
    {
      name: "docker push without visible SBOM",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push ghcr.io/example/app:latest\n",
      errors: [{ messageIncludes: "no recognized SBOM generation" }],
    },
    {
      name: "build push action with SBOM disabled",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@0123456789012345678901234567890123456789\n        with:\n          push: true\n          sbom: false\n",
      errors: 1,
    },
    {
      name: "vulnerability scanning alone is not SBOM generation",
      files: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: anchore/scan-action@0123456789012345678901234567890123456789\n      - run: docker push ghcr.io/example/app:latest\n",
      errors: [{ messageIncludes: "no recognized SBOM generation" }],
    },
  ],
});
