import { describe, expect, it } from "vitest";
import { matrixCombinations, matrixText } from "../../../src/lint/parsers/matrix.js";

describe("literal matrix expansion", () => {
  it("applies partial exclusions before include merges and appended entries", () => {
    expect(matrixCombinations({
      os: ["ubuntu", "windows"], arch: ["x64", "arm64"],
      exclude: [{ os: "windows", arch: "arm64" }],
      include: [{ cache: "shared" }, { os: "ubuntu", cache: "linux" }, { os: "macos", arch: "arm64" }],
    })).toEqual([
      { os: "ubuntu", arch: "x64", cache: "linux" },
      { os: "ubuntu", arch: "arm64", cache: "linux" },
      { os: "windows", arch: "x64", cache: "shared" },
      { os: "macos", arch: "arm64" },
    ]);
  });

  it("does not cross-product correlated include-only dimensions", () => {
    const legs = [{ os: "ubuntu", arch: "x64" }, { os: "windows", arch: "arm64" }];
    expect(matrixCombinations({ include: legs })).toEqual(legs);
  });

  it("does not merge later include entries into previously appended combinations", () => {
    expect(matrixCombinations({ os: ["ubuntu"], include: [{ os: "macos" }, { os: "macos", arch: "arm64" }] })).toEqual([
      { os: "ubuntu" }, { os: "macos" }, { os: "macos", arch: "arm64" },
    ]);
  });

  it("keeps literal types distinct rather than guessing expression coercions", () => {
    expect(matrixCombinations({ version: [1, "1"], exclude: [{ version: 1 }] })).toEqual([{ version: "1" }]);
  });

  it.each([
    { os: "${{ inputs.os }}" },
    { os: ["ubuntu"], include: [{ os: "${{ inputs.os }}" }] },
    { os: [] },
    { os: ["ubuntu"], exclude: [{ os: { name: "ubuntu" } }] },
    { a: Array.from({ length: 32 }, (_, i) => i), b: Array.from({ length: 32 }, (_, i) => i) },
  ])("returns unknown for unsupported or oversized matrices", (matrix) => {
    expect(matrixCombinations(matrix)).toBeUndefined();
  });

  it("returns unknown instead of throwing on cyclic or unserializable inputs", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.os = [cyclic];
    expect(matrixCombinations(cyclic)).toBeUndefined();
    expect(matrixCombinations({ version: [1n] })).toBeUndefined();
  });

  it("resolves only direct references, preserving unknown expressions", () => {
    const leg = { os: "ubuntu", runner: { arch: "arm64" }, enabled: false };
    expect(matrixText("${{ matrix.os }}-${{ matrix.runner.arch }}-${{ matrix.enabled }}", leg)).toBe("ubuntu-arm64-false");
    expect(matrixText("${{ matrix.missing }}", leg)).toBe("");
    expect(matrixText("${{ matrix.runner }}", leg)).toBeUndefined();
    expect(matrixText("${{ matrix.os || 'ubuntu' }}", leg)).toBeUndefined();
    expect(matrixText("${{ runner.os }}", leg)).toBeUndefined();
    expect(matrixText("${{ matrix.os", leg)).toBeUndefined();
  });
});
