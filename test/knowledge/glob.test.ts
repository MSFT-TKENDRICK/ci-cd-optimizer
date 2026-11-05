import { describe, expect, it } from "vitest";
import { matchesGlob } from "../../src/utils.js";

describe("bounded workspace/inventory glob matching", () => {
  it.each([
    ["a", "*", true], ["a/b", "*", false], ["a/b", "**", true],
    ["package.json", "**/package.json", true], ["a/b/package.json", "**/package.json", true],
    ["a/package.json", "a/**/package.json", true], ["a/b/c", "a/**/c", true],
    ["a/x", "a/?", true], ["a/x/y", "a/?", false], ["abc", "a**/bc", true],
    ["a/xbc", "a**/bc", false], ["abc", "a*b?", true], ["a/c", "**/**/c", true],
    ["a+b", "a+b", true], ["a.b", "a?b", true], ["", "**/", true],
    ["a\n", "a", false], ["a\n", "**", false], ["a\n", "*", true],
  ])("matches %j against %j as %j", (path, pattern, expected) => {
    expect(matchesGlob(path, pattern)).toBe(expected);
  });

  it("rejects adversarial repeated stars in polynomial work rather than exponential backtracking", () => {
    expect(matchesGlob("a".repeat(500), `${"*a".repeat(50)}b`)).toBe(false);
    expect(matchesGlob("a/".repeat(250), `${"**/".repeat(50)}b`)).toBe(false);
  });
});
