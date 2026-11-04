import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/registries/github-npm.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const workflow = (steps: string) =>
  `name: release\non: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    permissions:\n      packages: write\n    steps:\n${steps}`;

const GITHUB = "https://npm.pkg.github.com";
const NPMJS = "https://registry.npmjs.org/";

const monorepoRoot = json({ name: "acme", private: true, workspaces: ["packages/*"] });

ruleTester(rule, {
  valid: [
    {
      name: "publishConfig targets the GitHub npm registry",
      files: { "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { registry: GITHUB } }) },
    },
    {
      name: "private scoped package and unscoped package",
      files: {
        "package.json": monorepoRoot,
        "packages/app/package.json": json({ name: "@acme/app", version: "1.0.0", private: true }),
        "packages/pad/package.json": json({ name: "left-pad", version: "1.0.0" }),
      },
    },
    {
      name: ".npmrc maps the scope to GitHub Packages",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0" }),
        ".npmrc": `@acme:registry=${GITHUB}\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`,
      },
    },
    {
      name: "missing publishConfig is not claimed in files mode",
      mode: "files",
      files: { "package.json": json({ name: "@acme/ui", version: "1.0.0" }) },
    },
    {
      name: "setup-node publishes to GitHub Packages",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0" }),
        ".github/workflows/release.yml": workflow(`      - uses: actions/setup-node@v4
        with:
          registry-url: ${GITHUB}
          scope: "@acme"
      - run: npm publish
`),
      },
    },
    {
      name: "third-party scopes and environment-provided registries in .npmrc",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { registry: GITHUB } }),
        ".npmrc": "@fortawesome:registry=https://npm.fontawesome.com/\n@acme:registry=${ACME_REGISTRY}\n",
      },
    },
    {
      name: "scopes option limits which scopes are internal",
      options: { scopes: ["@acme"] },
      files: {
        "package.json": monorepoRoot,
        "packages/sdk/package.json": json({ name: "@acme-oss/sdk", version: "1.0.0", publishConfig: { registry: NPMJS } }),
      },
    },
    {
      name: "dry-run publishes and npm run publish scripts",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { registry: GITHUB } }),
        ".github/workflows/release.yml": workflow(`      - uses: actions/setup-node@v4
        with:
          registry-url: ${NPMJS}
      - run: |
          npm publish --dry-run --registry ${NPMJS}
          npm run publish
`),
      },
    },
  ],
  invalid: [
    {
      name: "publishConfig.registry points at npmjs",
      files: { "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { access: "public", registry: NPMJS } }) },
      errors: [{ path: "package.json", line: 6, messageIncludes: "`@acme/ui` publishes to `https://registry.npmjs.org/`" }],
    },
    {
      name: "workspace package without publishConfig",
      files: {
        "package.json": monorepoRoot,
        "packages/ui/package.json": json({ name: "@acme/ui", version: "1.0.0", main: "dist/index.js" }),
        "packages/app/package.json": json({ name: "@acme/app", private: true }),
      },
      errors: [{ path: "packages/ui/package.json", line: 2, messageIncludes: "has no `publishConfig.registry` and no `.npmrc` mapping for `@acme`" }],
    },
    {
      name: "setup-node registry-url targets npmjs for npm publish",
      files: {
        "package.json": json({ name: "@acme/cli", version: "2.0.0" }),
        ".github/workflows/release.yml": workflow(`      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: ${NPMJS}
      - run: npm ci
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`),
      },
      errors: [
        { path: ".github/workflows/release.yml", line: 12, messageIncludes: "`publish` step on line 14" },
        { path: "package.json", line: 2, messageIncludes: "has no `publishConfig.registry`" },
      ],
    },
    {
      name: "explicit --registry on pnpm and yarn publish",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { registry: GITHUB } }),
        ".github/workflows/release.yml": workflow(`      - run: |
          pnpm -r publish --registry=${NPMJS} --no-git-checks
          NPM_CONFIG_PROVENANCE=true yarn publish --registry https://artifactory.example.com/api/npm/npm/
`),
      },
      errors: [
        { path: ".github/workflows/release.yml", line: 10, messageIncludes: "publishes to `https://registry.npmjs.org/`" },
        { path: ".github/workflows/release.yml", line: 11, messageIncludes: "`https://artifactory.example.com/api/npm/npm/`" },
      ],
    },
    {
      name: ".npmrc maps the internal scope to another registry",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { registry: GITHUB } }),
        "packages/tools/.npmrc": `registry=${NPMJS}\n@ACME:registry=https://artifactory.example.com/api/npm/npm/\n`,
      },
      errors: [{ path: "packages/tools/.npmrc", line: 2, messageIncludes: "maps the internal scope `@acme`" }],
    },
    {
      name: "scoped publishConfig override with configured scopes",
      options: { scopes: ["acme"] },
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { "@acme:registry": "https://acme.jfrog.io/npm/" } }),
      },
      errors: [{ path: "package.json", line: 5, messageIncludes: "publishes to `https://acme.jfrog.io/npm/`" }],
    },
    {
      name: "publish inside a local composite action",
      files: {
        "package.json": json({ name: "@acme/ui", version: "1.0.0", publishConfig: { registry: GITHUB } }),
        ".github/workflows/release.yml": workflow("      - uses: actions/checkout@v5\n      - uses: ./.github/actions/publish\n"),
        ".github/actions/publish/action.yml":
          "name: publish\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: npx changeset publish --registry https://registry.npmjs.org\n",
      },
      errors: [{ path: ".github/actions/publish/action.yml", line: 6, messageIncludes: "publishes to `https://registry.npmjs.org`" }],
    },
  ],
});

describe("registries/github-npm details", () => {
  it("suggests the GitHub registry, packages: write, and GITHUB_TOKEN", () => {
    const [diagnostic] = runRule(rule, { files: { "package.json": json({ name: "@acme/ui", version: "1.0.0" }) } });
    expect(diagnostic?.severity).toBe("info");
    expect(diagnostic?.suggestion).toContain(`"publishConfig": { "registry": "${GITHUB}" }`);
    expect(diagnostic?.suggestion).toContain(`@acme:registry=${GITHUB}`);
    expect(diagnostic?.suggestion).toContain("packages: write");
    expect(diagnostic?.suggestion).toContain("NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("validates the scopes option", () => {
    expect(rule.meta.validateOptions?.({ scopes: ["@acme", "tools"] })).toEqual([]);
    expect(rule.meta.validateOptions?.({})).toEqual([]);
    expect(rule.meta.validateOptions?.({ scopes: "@acme" })).toHaveLength(1);
    expect(rule.meta.validateOptions?.({ scopes: ["not a scope"] })).toHaveLength(1);
  });

  it("is a GitHub-only policy rule", () => {
    expect(rule.meta.kind).toBe("policy");
    expect(rule.meta.presets).toEqual(["github"]);
  });
});
