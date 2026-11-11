import rule from "../../../../src/lint/rules/ssdf/static-cloud-credentials.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    { name: "OIDC role does not pass static keys", files: "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: aws-actions/configure-aws-credentials@0123456789012345678901234567890123456789\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/deploy\n" },
    { name: "another cloud action is ignored", files: "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: azure/login@0123456789012345678901234567890123456789\n" },
  ],
  invalid: [
    { name: "AWS static key inputs", files: "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: aws-actions/configure-aws-credentials@0123456789012345678901234567890123456789\n        with:\n          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}\n", errors: [{ messageIncludes: "static credential input" }] },
    { name: "Azure credential JSON", files: "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: azure/login@0123456789012345678901234567890123456789\n        with:\n          creds: ${{ secrets.AZURE_CREDENTIALS }}\n", errors: 1 },
  ],
});
