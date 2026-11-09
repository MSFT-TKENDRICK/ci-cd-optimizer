import rule from "../../../../src/lint/rules/security/secrets-bulk-expose.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (...stepLines: string[]): string =>
  yml("on: push", "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "secret written to a file",
      files: wf('      - run: echo "${{ secrets.KEY }}" > key.pem'),
    },
    {
      name: "secret piped to gh auth login --with-token",
      files: wf('      - run: echo "${{ secrets.GH_PAT }}" | gh auth login --with-token'),
    },
    {
      name: "secret passed to a tool via env",
      files: wf("      - env:", "          TOKEN: ${{ secrets.DEPLOY_TOKEN }}", "        run: ./deploy.sh"),
    },
    {
      name: "secret piped into a login command",
      files: wf('      - run: echo "${{ secrets.REGISTRY_PASSWORD }}" | docker login -u me --password-stdin'),
    },
    {
      name: "masking a derived value",
      files: wf('      - run: echo "::add-mask::${{ secrets.TOKEN }}"'),
    },
    {
      name: "commented out toJSON",
      files: wf("      - run: echo hi", "# ALL: ${{ toJSON(secrets) }}"),
    },
  ],
  invalid: [
    {
      name: "secret piped through base64 escapes masking",
      files: wf('      - run: echo "${{ secrets.TOKEN }}" | base64'),
      errors: 1,
    },
    {
      name: "bracket access to a secret",
      files: wf("      - run: echo \"${{ secrets['TOKEN'] }}\""),
      errors: 1,
    },
    {
      name: "toJSON(secrets) anywhere",
      files: wf("      - env:", "          ALL: ${{ toJSON(secrets) }}", "        run: ./x.sh"),
      errors: [{ line: 8, messageIncludes: "toJSON(secrets)" }],
    },
    {
      name: "echoing a secret expression",
      files: wf('      - run: echo "token=${{ secrets.TOKEN }}"'),
      errors: 1,
    },
    {
      name: "echoing an env var bound to a secret",
      files: wf("      - env:", "          KEY: ${{ secrets.API_KEY }}", '        run: echo "key is $KEY"'),
      errors: 1,
    },
  ],
});