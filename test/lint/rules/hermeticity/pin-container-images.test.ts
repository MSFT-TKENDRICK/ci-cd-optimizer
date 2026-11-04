import rule from "../../../../src/lint/rules/hermeticity/pin-container-images.js";
import { ruleTester } from "../../rule-tester.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n${body}    steps:\n      - run: make\n`;

ruleTester(rule, {
  valid: [
    { name: "tagged container", files: wf("    container: node:22-bookworm\n") },
    { name: "tagged service (object form)", files: wf("    services:\n      db:\n        image: postgres:17.6\n") },
    { name: "digest-pinned image", files: wf(`    container:\n      image: node@${DIGEST}\n`) },
    { name: "expressions are unknown", files: wf("    container: ${{ matrix.image }}\n    services:\n      db:\n        image: postgres:${{ matrix.pg }}\n") },
    { name: "registry port is not a tag", files: wf("    container: localhost:5000/tools:1.4\n") },
    { name: "requireDigest accepts digests", files: wf(`    container: node:22@${DIGEST}\n`), options: { requireDigest: true } },
  ],
  invalid: [
    { name: "untagged container", files: wf("    container: node\n"), errors: [{ line: 5, messageIncludes: "has no tag" }] },
    { name: "latest container (object form)", files: wf("    container:\n      image: ghcr.io/o/tools:latest\n"), errors: [{ line: 6, messageIncludes: "`latest`" }] },
    {
      name: "services",
      files: wf("    services:\n      db:\n        image: postgres\n      cache:\n        image: redis:latest\n      ok:\n        image: nginx:1.29\n"),
      errors: [
        { line: 7, messageIncludes: "Service `db`" },
        { line: 9, messageIncludes: "Service `cache`" },
      ],
    },
    { name: "docker:// prefix is stripped", files: wf("    container: docker://alpine\n"), errors: [{ messageIncludes: "`alpine`" }] },
    {
      name: "requireDigest flags tagged images",
      files: wf("    container: node:22\n    services:\n      db:\n        image: postgres:17.6\n"),
      options: { requireDigest: true },
      errors: [
        { line: 5, messageIncludes: "sha256" },
        { line: 8, messageIncludes: "sha256" },
      ],
    },
  ],
});
