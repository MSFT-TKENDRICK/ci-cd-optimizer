import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { matrixCombinations } from "../../../src/lint/parsers/matrix.js";
import cache from "../../../src/lint/rules/caching/matrix-cache-key-missing-os.js";
import scope from "../../../src/lint/rules/containers/gha-cache-missing-scope.js";
import explosion from "../../../src/lint/rules/workflow/matrix-explosion.js";
import { runRule } from "../rule-tester.js";

const workflow = (matrix: Record<string, unknown>, steps: Record<string, unknown>[]): string => stringify({
  on: "push",
  jobs: { build: { "runs-on": "${{ matrix.os }}", strategy: { matrix }, steps } },
});
const cacheStep = (key = "${{ matrix.key }}"): Record<string, unknown> => ({
  uses: "actions/cache@v6", with: { path: "node_modules", key },
});
const buildStep = (cacheScope = "${{ matrix.os }}"): Record<string, unknown> => ({
  uses: "docker/build-push-action@v7",
  with: { platforms: "${{ matrix.platform }}", "cache-to": `type=gha,mode=max,scope=${cacheScope}` },
});

describe("cache comparisons use actual literal matrix combinations", () => {
  it("keeps include-only correlated operating systems and cache keys distinct", () => {
    const matrix = { include: [{ os: "ubuntu-24.04", key: "linux" }, { os: "macos-latest", key: "mac" }] };
    expect(runRule(cache, { files: workflow(matrix, [cacheStep()]) })).toEqual([]);
  });

  it("applies include merges before comparing keys", () => {
    const matrix = {
      os: ["ubuntu-24.04", "macos-latest"],
      include: [{ os: "ubuntu-24.04", key: "linux" }, { os: "macos-latest", key: "mac" }],
    };
    expect(runRule(cache, { files: workflow(matrix, [cacheStep()]) })).toEqual([]);
  });

  it("does not compare an excluded operating system", () => {
    const matrix = { os: ["ubuntu-24.04", "macos-latest"], exclude: [{ os: "macos-latest" }] };
    expect(runRule(cache, { files: workflow(matrix, [cacheStep("${{ github.sha }}")]) })).toEqual([]);
  });

  it("reports an equal modeled key across distinct non-Windows platforms without rewriting it", () => {
    const matrix = { include: [{ os: "ubuntu-24.04", key: "shared" }, { os: "macos-latest", key: "shared" }] };
    const diagnostics = runRule(cache, { files: workflow(matrix, [cacheStep()]) });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.fix).toBeUndefined();
  });

  it("keeps the Windows default cache-version partition even with equal keys", () => {
    const matrix = { include: [{ os: "ubuntu-24.04", key: "shared" }, { os: "windows-2025", key: "shared" }] };
    expect(runRule(cache, { files: workflow(matrix, [cacheStep()]) })).toEqual([]);
  });

  it("does not demand another scope dimension for correlated include-only builds", () => {
    const matrix = { include: [
      { os: "ubuntu-24.04", platform: "linux/amd64" }, { os: "ubuntu-24.04-arm", platform: "linux/arm64" },
    ] };
    expect(runRule(scope, { files: workflow(matrix, [buildStep()]) })).toEqual([]);
  });

  it("honors exclusions that correlate build platform and runner", () => {
    const matrix = {
      os: ["ubuntu-24.04", "ubuntu-24.04-arm"], platform: ["linux/amd64", "linux/arm64"],
      exclude: [{ os: "ubuntu-24.04", platform: "linux/arm64" }, { os: "ubuntu-24.04-arm", platform: "linux/amd64" }],
    };
    expect(runRule(scope, { files: workflow(matrix, [buildStep()]) })).toEqual([]);
  });

  it("reports genuinely shared scope for two modeled platform variants", () => {
    const matrix = { os: ["ubuntu-24.04"], platform: ["linux/amd64", "linux/arm64"] };
    const diagnostics = runRule(scope, { files: workflow(matrix, [buildStep()]) });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.fix).toBeUndefined();
  });
});

describe("sparse matrix suggestions preserve non-version coverage", () => {
  const matrix = {
    os: ["ubuntu-24.04", "windows-2025", "macos-latest"],
    python: ["3.9", "3.10", "3.11", "3.13"],
    database: ["postgres", "mysql"],
    shard: [1, 2],
  };

  it("emits parseable YAML covering every database/shard pair on every original runner", () => {
    const diagnostics = runRule(explosion, { files: workflow(matrix, [{ run: "pytest --shard ${{ matrix.shard }}" }]) });
    expect(diagnostics).toHaveLength(1);
    const suggestion = diagnostics[0]?.suggestion ?? "";
    expect(suggestion).toContain("coverage tradeoff, not an equivalent replacement");
    const document = parse(suggestion.slice(suggestion.indexOf("strategy:"))) as { strategy: { matrix: Record<string, unknown> } };
    const combinations = matrixCombinations(document.strategy.matrix);
    expect(combinations).toHaveLength(16);
    for (const os of matrix.os) for (const database of matrix.database) for (const shard of matrix.shard) {
      expect(combinations?.some((combination) => combination.os === os && combination.database === database && combination.shard === shard)).toBe(true);
    }
    expect(new Set(combinations?.map((combination) => combination.python))).toEqual(new Set(["3.9", "3.13"]));
    expect(diagnostics[0]?.fix).toBeUndefined();
  });

  it.each([{ include: [{ os: "ubuntu-24.04", extra: true }] }, { exclude: [{ os: "macos-latest", python: "3.10" }] }])(
    "does not replace existing conditional coverage %j", (extra) => {
      const diagnostics = runRule(explosion, { files: workflow({ ...matrix, ...extra }, [{ run: "pytest" }]) });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.suggestion).toContain("no replacement is generated");
      expect(diagnostics[0]?.suggestion).not.toContain("strategy:");
    },
  );
});
