import { describe, expect, it } from "vitest";
import install from "../../../../src/lint/rules/hooks/install-in-hook.js";
import repoScan from "../../../../src/lint/rules/hooks/pre-commit-repo-scan.js";
import { buildProject } from "../../../../src/lint/project.js";
import { ruleTester } from "../../rule-tester.js";

const config = (entry: string, extra = "") => `repos:
  - repo: local
    hooks:
      - id: lint
        language: system
        entry: ${entry}
${extra}`;

ruleTester(install, {
  valid: [
    { name: "checks remain in hook", files: { ".githooks/pre-commit": "#!/bin/sh\nnpm run lint\nnpm test\n" } },
    { name: "comment and heredoc are not commands", files: { ".githooks/pre-commit": "#!/bin/sh\n# npm ci\ncat <<EOF\nnpm ci\nEOF\n" } },
    { name: "non-shell hook is opaque", files: { ".githooks/pre-commit": "#!/usr/bin/env node\nconsole.log('npm ci')\n" } },
    { name: "unknown remote entry", files: { ".pre-commit-config.yaml": "repos:\n  - repo: https://example.invalid/hooks\n    rev: v1\n    hooks:\n      - id: install\n" } },
    { name: "unrelated script is not a hook", files: { "scripts/pre-commit.sh": "#!/bin/sh\nnpm ci\n" } },
    { name: "global installation is not project provisioning", files: { ".husky/pre-commit": "#!/bin/sh\nnpm install -g tool\n" } },
  ],
  invalid: [
    { name: "Git hook with wrapped install", files: { ".githooks/pre-commit": "#!/usr/bin/env sh\nset -eu\nnpm ci && npm run lint\n" }, errors: [{ line: 3, messageIncludes: "npm ci" }], output: null },
    { name: "Husky push install", files: { ".husky/pre-push": "#!/bin/bash\nexec env X=1 pnpm install --frozen-lockfile\n" }, errors: [{ line: 2 }], output: null },
    { name: "modern Husky hook without shebang", files: { ".husky/pre-commit": "npm ci\nnpm run lint\n" }, errors: [{ line: 1 }], output: null },
    { name: "local pre-commit install entry", files: { ".pre-commit-config.yaml": config("npm ci") }, errors: [{ line: 6 }], output: null },
    { name: "published hook definition", files: { ".pre-commit-hooks.yaml": "- id: check\n  entry: yarn install\n  language: system\n" }, errors: [{ line: 2 }], output: null },
  ],
});

ruleTester(repoScan, {
  valid: [
    { name: "whole-repo pass_filenames disabled", files: { ".pre-commit-config.yaml": config("eslint .", "        pass_filenames: false\n") } },
    { name: "staged-file checker preserves filenames", files: { ".pre-commit-config.yaml": config("eslint") } },
    { name: "dot is an option value, not scope", files: { ".pre-commit-config.yaml": config("eslint --ignore-path .") } },
    { name: "opaque wrapper", files: { ".pre-commit-config.yaml": config("sh -c 'eslint .'") } },
    { name: "Git hook does not receive pre-commit batches", files: { ".githooks/pre-commit": "#!/bin/sh\neslint .\n" } },
    { name: "malformed YAML reports parse problem, not advice", files: { ".pre-commit-config.yaml": "repos: [\n" } },
  ],
  invalid: [
    { name: "explicit repo checker with default filenames", files: { ".pre-commit-config.yaml": config("eslint .") }, errors: [{ line: 6, messageIncludes: "filename batches can repeat" }], output: null },
    { name: "prettier whole repo", files: { ".pre-commit-config.yaml": config("prettier --check .", "        pass_filenames: true\n") }, errors: 1, output: null },
    { name: "published optimizer definition", files: { ".pre-commit-hooks.yaml": "- id: cicd\n  entry: cicd-lint .\n  language: system\n" }, errors: [{ line: 2 }], output: null },
  ],
});

describe("hook parsing", () => {
  it("reports invalid pre-commit YAML in the shared project model", () => {
    const project = buildProject({ files: [{ path: ".pre-commit-config.yaml", content: "repos: [\n" }], mode: "files", inventoryComplete: false });
    expect(project.parseProblems).toEqual([expect.objectContaining({ path: ".pre-commit-config.yaml" })]);
  });
});
