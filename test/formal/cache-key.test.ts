import { describe, expect, it } from "vitest";
import { analyzeCacheKey, extractCacheKey, parseTemplate } from "../../src/formal/cache-key.js";
import type { SourceBlob } from "../../src/formal/source.js";

const workflow = (key = "npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}", extra = "") =>
  `name: cache\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v6\n        with:\n          key: "${key}"\n          path: .cache\n${extra}`;
const source = (content: string): SourceBlob => ({ content, commit: "a".repeat(40), path: ".github/workflows/ci.yml", blob: "b".repeat(40) });

describe("executable cache partition model", () => {
  it("recomputes uncovered and undetermined witnesses, then checks the pruned template", () => {
    const result = analyzeCacheKey("npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-${{ github.sha }}", null);
    expect(result.dependencies).toEqual(["hashFiles('package-lock.json')", "runner.os"]);
    expect(result.exactPartition).toBe(false);
    expect(result.uncovered).toEqual([]);
    expect(result.undetermined).toHaveLength(1);
    expect(result.undetermined[0]).toMatchObject({ varied: "github.sha", keyEqual: false, dependenciesEqual: true });
    expect(result.undetermined[0]?.leftKey).toBe(`npm-Linux--${"0".repeat(40)}`);
    expect(result.recommendation).toMatchObject({ key: "npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-", supported: true, exactPartition: true, coarsensOriginalPartition: true });
    const uncovered = analyzeCacheKey("static", ["runner.os"]);
    expect(uncovered.uncovered[0]).toMatchObject({ varied: "runner.os", leftKey: "static", rightKey: "static", keyEqual: true, dependenciesEqual: false });
    expect(uncovered.recommendation.exactPartition).toBe(false);
    expect(analyzeCacheKey("static", []).exactPartition).toBe(true);
  });

  it("does not confuse assumptions about D with actual workload dependencies", () => {
    expect(analyzeCacheKey("${{ github.sha }}", ["github.sha"]).exactPartition).toBe(true);
    expect(analyzeCacheKey("${{ github.sha }}", null).undetermined).toHaveLength(1);
    expect(() => analyzeCacheKey("a", ["runner.os", " runner.os "])).toThrow(/Duplicate/);
  });

  it("models empty hashFiles, fixed-width SHA and arbitrary context alphabets", () => {
    expect(() => analyzeCacheKey("${{ hashFiles('lock') }}${{ github.sha }}", null)).toThrow(/separated/);
    expect(() => analyzeCacheKey("${{ runner.os }}Linux${{ hashFiles('lock') }}", null)).toThrow(/separated/);
    expect(() => analyzeCacheKey("${{ github.ref }}-${{ runner.os }}", null)).toThrow(/separated/);
    expect(analyzeCacheKey("${{ github.sha }}${{ github.ref }}", ["github.sha", "github.ref"]).exactPartition).toBe(true);
    expect(analyzeCacheKey("${{ github.ref }}", ["github.ref"]).exactPartition).toBe(true);
    const hash = analyzeCacheKey("${{ hashFiles('lock') }}", []);
    expect(hash.undetermined[0]).toMatchObject({ leftKey: "", rightKey: "a".repeat(64), keyEqual: false });
  });

  it("preserves scalar Unicode and parses only the declared expression grammar", () => {
    const unicode = analyzeCacheKey("😀λ-${{ runner.os }}∴${{ hashFiles('锁') }}", []);
    expect(unicode.undetermined[0]?.leftKey).toBe("😀λ-Linux∴");
    expect(parseTemplate("${{ hashFiles('a,b','it''s}}.lock') }}")).toEqual([{ kind: "hash", patterns: ["a,b", "it's}}.lock"] }]);
    for (const bad of ["${{ matrix.os }}", "${{ github['sha'] }}", "${{ hashFiles(env.PATH) }}", "${{ hashFiles('a',) }}", "${{ hashFiles() }}", "${{ github.sha", "\ud800"]) {
      expect(() => analyzeCacheKey(bad, null)).toThrow();
    }
  });

  it("does not serialize a model literal into a newly active Actions expression", () => {
    for (const suffix of ["matrix.os", "github.sha"]) {
      const result = analyzeCacheKey(`$\${{ github.sha }}{{ ${suffix} }}`, []);
      expect(result.recommendation).toMatchObject({ key: null, supported: false, coarsensOriginalPartition: true });
    }
  });
});

describe("trusted workflow extraction boundary", () => {
  it("records exact UTF-8 scalar bytes and offsets, including CRLF and non-BMP text", () => {
    const content = workflow("😀-${{ runner.os }}").replaceAll("\n", "\r\n");
    const extracted = extractCacheKey(source(content), "build", 0);
    expect(extracted.key).toBe("😀-${{ runner.os }}");
    const bytes = Buffer.from(content);
    expect(bytes.subarray(extracted.utf8Start, extracted.utf8End)).toEqual(Buffer.from(extracted.rawKeyBase64, "base64"));
    expect(Buffer.from(extracted.rawKeyBase64, "base64").toString("utf8")).toBe('"😀-${{ runner.os }}"');
  });

  it("rejects restore fallbacks, cross-OS settings, aliases, duplicates and unsupported actions", () => {
    for (const extra of ['          restore-keys: ""\n', '          Restore-Keys: ""\n', "          enableCrossOsArchive: false\n", "          enablecrossosarchive: true\n", "          key: duplicate\n", "          KEY: collision\n"]) {
      expect(() => extractCacheKey(source(workflow(undefined, extra)), "build", 0)).toThrow();
    }
    expect(() => extractCacheKey(source(workflow().replace("actions/cache@v6", "custom/cache@v1")), "build", 0)).toThrow(/literal actions\/cache/);
    expect(() => extractCacheKey(source(`${workflow()}a: &a 1\nb: *a\n`), "build", 0)).toThrow(/aliases/);
    expect(() => extractCacheKey(source(workflow()), "build", -1)).toThrow();
    expect(() => extractCacheKey(source(workflow()), "missing", 0)).toThrow();
  });

  it("binds the whole folded scalar token, not just its decoded key", () => {
    const raw = ">-\n            npm-\n            ${{ runner.os }}\n";
    const content = `jobs:\n  build:\n    steps:\n      - uses: actions/cache/restore@v6\n        with:\n          key: ${raw}          path: .cache\n`;
    const extracted = extractCacheKey(source(content), "build", 0);
    expect(extracted.key).toBe("npm- ${{ runner.os }}");
    expect(Buffer.from(extracted.rawKeyBase64, "base64").toString("utf8")).toBe(raw);
  });
});
