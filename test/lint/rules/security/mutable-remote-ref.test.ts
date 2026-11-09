import rule from "../../../../src/lint/rules/security/mutable-remote-ref.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (...runLines: string[]): string =>
  yml("on: push", "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...runLines.map((line) => `      - run: ${line}`));

const sha = "3f1c2b9e8d7a6f5e4d3c2b1a09f8e7d6c5b4a392";

ruleTester(rule, {
  valid: [
    { name: "pip from a sha", files: wf(`pip install git+https://github.com/o/r.git@${sha}`) },
    { name: "pip from a version tag", files: wf("pip install git+https://github.com/o/r.git@v1.2.3") },
    { name: "regular registry installs", files: wf("pip install requests==2.32.0", "npm install lodash@4.17.21") },
    { name: "npm from a github sha", files: wf(`npm install github:o/r#${sha}`) },
    { name: "npm semver range", files: wf("npm install github:o/r#semver:^1.0.0") },
    { name: "go install a version", files: wf("go install golang.org/x/tools/cmd/goimports@v0.24.0") },
    { name: "cargo with rev", files: wf(`cargo install --git https://github.com/o/r --rev ${sha}`) },
    { name: "echoed text", files: wf("echo pip install git+https://github.com/o/r.git") },
  ],
  invalid: [
    {
      name: "pip from main",
      files: wf("pip install git+https://github.com/o/r.git@main"),
      errors: [{ line: 7, messageIncludes: "`main`" }],
    },
    {
      name: "pip from default branch",
      files: wf("python -m pip install 'git+https://github.com/o/r.git'"),
      errors: [{ messageIncludes: "default branch" }],
    },
    { name: "npm github shorthand", files: wf("npm install github:o/r"), errors: 1 },
    { name: "yarn add git branch", files: wf("yarn add git+https://github.com/o/r.git#develop"), errors: 1 },
    { name: "go install latest", files: wf("go install github.com/o/tool@latest"), errors: 1 },
    { name: "cargo git without rev", files: wf("cargo install --git https://github.com/o/r tool"), errors: 1 },
  ],
});