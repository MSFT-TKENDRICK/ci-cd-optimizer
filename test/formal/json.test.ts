import { describe, expect, it } from "vitest";
import { canonicalJson, parseStrictJson } from "../../src/formal/json.js";

describe("strict canonical certificate JSON", () => {
  it("sorts keys, preserves Unicode and does not inherit object properties", () => {
    expect(canonicalJson(parseStrictJson('{"z":"😀","a":1,"__proto__":{"polluted":true}}'))).toBe('{"__proto__":{"polluted":true},"a":1,"z":"😀"}');
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(parseStrictJson('{"value":0.125}', true)).toEqual({ value: 0.125 });
  });

  it.each([
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}', "NaN", "Infinity", "1e400", "1e-400",
    "9007199254740993", "-0", "0.5", '"\\ud800"', '"\\udfff"', '{"a":1,}', "[1,]", "01", "{} true", "/*x*/{}",
  ])("rejects ambiguous/invalid input %s", (text) => {
    expect(() => parseStrictJson(text)).toThrow();
  });

  it("rejects lossy decimal decoding, noninteger certificate fields, accessors and hidden values", () => {
    expect(() => parseStrictJson("0.10000000000000001", true)).toThrow(/round-trippable/);
    for (const value of [NaN, Infinity, -Infinity, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined, "\ud800"]) expect(() => canonicalJson(value)).toThrow();
    const accessor = Object.defineProperty({}, "x", { get() { throw new Error("must not execute"); }, enumerable: true });
    expect(() => canonicalJson(accessor)).toThrow(/Accessors/);
    const array = Object.defineProperty([], "0", { get() { throw new Error("must not execute"); }, enumerable: true });
    expect(() => canonicalJson(array)).toThrow(/accessor/);
    expect(() => canonicalJson(new Array(2))).toThrow(/Sparse/);
    expect(() => canonicalJson(new Date())).toThrow(/plain/);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow(/Invalid/);
  });
});
