import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../../src/lint/config.js";
import { lint } from "../../../../src/lint/engine.js";
import { allRules } from "../../../../src/lint/rules/index.js";
import rule from "../../../../src/lint/rules/workflow/artifact-success-gating.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const workflow = (...jobs: string[]): string => `on: [push, pull_request, merge_group]\njobs:\n${jobs.join("\n")}\n`;
const producer = (jobFields = "", uploadFields = "", name = "dist", id = "producer"): string =>
  `  ${id}:
    runs-on: ubuntu-latest
${jobFields}
    steps:
      - run: ./compile.sh
      - uses: actions/upload-artifact@v4
${uploadFields}
        with:
          name: ${name}
          path: dist
      - run: ./verify.sh`;
const consumer = (jobFields = "", downloadFields = "", inputs = "          name: dist"): string =>
  `  consumer:
    runs-on: ubuntu-latest
${jobFields}
    steps:
      - uses: actions/download-artifact@v4
${downloadFields}
        with:
${inputs}
      - run: ./use-dist.sh`;
const bridge = (condition = "", needs = "producer"): string =>
  `  bridge:
    runs-on: ubuntu-latest
    needs: ${needs}
${condition}
    steps:
      - run: echo done`;

ruleTester(rule, {
  valid: [
    { name: "direct scalar dependency", files: workflow(producer(), consumer("    needs: producer")) },
    { name: "direct list dependency", files: workflow(producer(), consumer("    needs: [producer]")) },
    { name: "transitive success gate", files: workflow(producer(), bridge(), consumer("    needs: bridge")) },
    ...["always()", "${{ !cancelled() }}"].map((condition) => ({
      name: `transitive needs is retained even with intermediate ${condition}`,
      files: workflow(producer(), bridge(`    if: ${JSON.stringify(condition)}`), consumer("    needs: bridge")),
    })),
    {
      name: "direct gate alongside bypassing transitive path",
      files: workflow(producer(), bridge("    if: always()"), consumer("    needs: [bridge, producer]")),
    },
    {
      name: "one effective transitive path suffices",
      files: workflow(producer(), bridge("    if: always()"), bridge().replaceAll("bridge:", "safe:"), consumer("    needs: [bridge, safe]")),
    },
    {
      name: "opaque result-aware intermediate may enforce producer result",
      files: workflow(producer(), bridge("    if: ${{ always() && needs.producer.result == 'success' }}"), consumer("    needs: bridge")),
    },
    {
      name: "conditional success gate is conservatively unanalysed",
      files: workflow(producer(), bridge("    if: github.ref == 'refs/heads/main'"), consumer("    needs: bridge")),
    },
    ...["always()", "failure()", "!cancelled()", "${{ always() && needs.producer.result != 'skipped' }}"].map((condition) => ({
      name: `intentional failure-aware consumer ${condition}`,
      files: workflow(producer(), consumer(`    needs: producer\n    if: ${JSON.stringify(condition)}`)),
    })),
    {
      name: "required-check aggregate handles all needs results and still fails",
      files: workflow(producer(), consumer(`    needs: producer
    if: always()
    env:
      RESULTS: \${{ toJSON(needs) }}`).replace("./use-dist.sh", "./check-required-results.sh")),
    },
    {
      name: "success-path aggregate with explicit outcome policy",
      files: workflow(producer(), consumer(`    env:
      RESULTS: \${{ toJSON(needs) }}`)),
    },
    {
      name: "multiline aggregate result policy remains intentional",
      files: workflow(producer(), consumer(`    env:
      RESULTS: |
        \${{ toJSON(
          needs
        ) }}`)),
    },
    {
      name: "failure-only diagnostic upload is not a success input producer",
      files: workflow(producer("", "        if: failure()"), consumer()),
    },
    {
      name: "failure-aware diagnostic consumer steps are intentional",
      files: workflow(producer(), consumer("", "        if: always()")),
    },
    { name: "optional download", files: workflow(producer(), consumer("", "        continue-on-error: true")) },
    { name: "optional consumer job", files: workflow(producer(), consumer("    continue-on-error: true")) },
    { name: "producer allowed to fail", files: workflow(producer("    continue-on-error: true"), consumer()) },
    { name: "expression-based producer tolerance", files: workflow(producer("    continue-on-error: ${{ inputs.optional }}"), consumer()) },
    { name: "optional upload", files: workflow(producer("", "        continue-on-error: true"), consumer()) },
    { name: "conditional producer", files: workflow(producer("    if: github.ref == 'refs/heads/main'"), consumer()) },
    { name: "conditional upload", files: workflow(producer("", "        if: inputs.upload"), consumer()) },
    {
      name: "matrix artifact producers are not a single producer contract",
      files: workflow(producer("    strategy:\n      fail-fast: false\n      matrix:\n        os: [ubuntu-latest, windows-latest]"), consumer()),
    },
    { name: "dynamic artifact names", files: workflow(producer("", "", "${{ matrix.name }}"), consumer()) },
    {
      name: "unknown upload could collide with a literal producer",
      files: workflow(producer(), producer("", "", "${{ inputs.name }}", "other"), consumer()),
    },
    { name: "dynamic download name", files: workflow(producer(), consumer("", "", "          name: ${{ inputs.name }}")) },
    { name: "case-sensitive artifact mismatch", files: workflow(producer(), consumer("", "", "          name: Dist")) },
    { name: "duplicate upload contract is ambiguous", files: workflow(producer(), producer("", "", "dist", "other"), consumer()) },
    ...["run-id: 123", "repository: owner/repo", "github-token: ${{ github.token }}", "artifact-ids: 123", "pattern: dist*"].map((selector) => ({
      name: `unsupported download selector ${selector}`,
      files: workflow(producer(), consumer("", "", `          name: dist\n          ${selector}`)),
    })),
    { name: "unnamed download of all artifacts", files: workflow(producer(), consumer("", "", "          path: dist")) },
    { name: "circular edge cannot be recommended", files: workflow(producer("    needs: consumer"), consumer()) },
    {
      name: "unrelated lint, test and deploy names are not dependency evidence",
      files: workflow("  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint",
        "  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
        "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./deploy.sh"),
    },
    {
      name: "separate workflows do not establish same-run transfer",
      files: { ".github/workflows/producer.yml": workflow(producer()), ".github/workflows/consumer.yml": workflow(consumer()) },
    },
    {
      name: "same-job upload and download do not require a self-edge",
      files: workflow(producer().replace("      - run: ./verify.sh", "      - uses: actions/download-artifact@v4\n        with:\n          name: dist")),
    },
    { name: "local action name cannot impersonate official download", files: workflow(producer(), consumer().replace("actions/download-artifact@v4", "./actions/download-artifact")) },
    {
      name: "other CI platform with similarly named jobs is not GitHub evidence",
      files: { "azure-pipelines.yml": "jobs:\n- job: producer\n  steps:\n  - publish: dist\n    artifact: dist\n- job: consumer\n  steps:\n  - download: current\n    artifact: dist\n" },
    },
  ],
  invalid: [
    {
      name: "literal same-run artifact without dependency (producer can fail after upload)",
      files: workflow(producer(), consumer()),
      errors: [{ messageIncludes: "has no needs path to that producer" }],
      output: null,
    },
    {
      name: "explicit success expressions remain success gated",
      files: workflow(producer("    if: ${{ success() }}"), consumer("    if: success()", "        if: ${{ success() }}")),
      errors: 1,
      output: null,
    },
    {
      name: "unrelated needs edge does not gate the artifact producer",
      files: workflow(producer(), bridge("", "[]"), consumer("    needs: bridge")),
      errors: [{ messageIncludes: "has no needs path" }],
      output: null,
    },
    {
      name: "default upload artifact name is literal artifact",
      files: workflow(producer().replace("          name: dist\n", ""), consumer("", "", "          name: artifact")),
      errors: 1,
      output: null,
    },
    {
      name: "false failure tolerance retains the required contract",
      files: workflow(producer("    continue-on-error: false", "        continue-on-error: false"), consumer("", "        continue-on-error: false")),
      errors: 1,
      output: null,
    },
    {
      name: "consumer matrix does not imply producer gating or matrix cancellation",
      files: workflow(producer(), consumer("    strategy:\n      fail-fast: true\n      matrix:\n        shard: [1, 2]")),
      errors: 1,
      output: null,
    },
    {
      name: "full workflow is sufficient in files mode",
      files: workflow(producer(), consumer()),
      mode: "files",
      inventoryComplete: false,
      errors: 1,
      output: null,
    },
  ],
});

it("reports one gate per producer/consumer, at the download with upload evidence and no fix", () => {
  const files = workflow(producer(), consumer().replace("      - run: ./use-dist.sh", "      - uses: actions/download-artifact@v4\n        with:\n          name: dist"));
  const diagnostics = runRule(rule, { files });
  expect(diagnostics).toHaveLength(1);
  const finding = diagnostics[0];
  const lines = files.split("\n");
  expect(lines[(finding?.line ?? 0) - 1]).toContain("actions/download-artifact");
  expect(lines[(finding?.related?.[0]?.line ?? 0) - 1]).toContain("actions/upload-artifact");
  expect(finding?.confidence).toBe("high");
  expect(finding?.fix).toBeUndefined();
  expect(finding?.suggestion).toContain("preserve existing dependencies");
  expect(finding?.suggestion).toContain("No autofix or runner-minute savings estimate");
});

it("is enabled as a warning through the built-in recommended registry", () => {
  const result = lint({
    files: [{ path: ".github/workflows/ci.yml", content: workflow(producer(), consumer()) }],
    mode: "files",
    inventoryComplete: false,
  }, { config: structuredClone(DEFAULT_CONFIG), rules: allRules });
  const findings = result.diagnostics.filter((entry) => entry.ruleId === rule.meta.id);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe("warn");
});
