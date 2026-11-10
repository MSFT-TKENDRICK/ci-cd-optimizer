import { createHash } from "node:crypto";
import { BigNumber } from "bignumber.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function scalarString(text: string): string {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Lone Unicode surrogate.");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Lone Unicode surrogate.");
  }
  return text;
}

/** JSON.parse alone loses duplicate keys and accepts overflowing numeric literals. */
export function parseStrictJson(text: string, fractions = false): Json {
  if (Buffer.byteLength(text, "utf8") > 8_000_000) throw new Error("JSON exceeds the 8 MB input limit.");
  let at = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[at] ?? "") && at < text.length) at += 1; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === "\\") { at += 1; continue; }
      if (ch === '"') {
        const value: unknown = JSON.parse(text.slice(start, at));
        if (typeof value !== "string") throw new Error("Expected a JSON string.");
        return scalarString(value);
      }
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth: number): Json => {
    if (depth > 64) throw new Error("JSON nesting exceeds 64 levels.");
    whitespace();
    const ch = text[at];
    if (ch === '"') return string();
    if (ch === "[" || ch === "{") {
      const object = ch === "{";
      const end = object ? "}" : "]";
      at += 1;
      whitespace();
      const array: Json[] = [];
      const record: JsonObject = Object.create(null);
      const keys = new Set<string>();
      if (text[at] === end) { at += 1; return object ? record : array; }
      while (at < text.length) {
        whitespace();
        if (object) {
          if (text[at] !== '"') throw new Error("Expected a JSON object key.");
          const key = string();
          if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
          keys.add(key);
          whitespace();
          if (text[at++] !== ":") throw new Error("Expected ':' after JSON key.");
          record[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace();
        if (text[at] === end) { at += 1; return object ? record : array; }
        if (text[at++] !== ",") throw new Error("Expected ',' in JSON container.");
      }
      throw new Error("Unterminated JSON container.");
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0];
    if (!token || token.length > 128) throw new Error("Invalid JSON value.");
    at += token.length;
    const number = Number(token);
    if (!Number.isFinite(number) || Object.is(number, -0) || Math.abs(number) > Number.MAX_SAFE_INTEGER ||
      (!fractions && !Number.isSafeInteger(number)) || !new BigNumber(token).eq(new BigNumber(number))) {
      throw new Error("Invalid or non-round-trippable JSON number.");
    }
    return number;
  };
  const parsed = value(0);
  whitespace();
  if (at !== text.length) throw new Error("Trailing JSON input.");
  return parsed;
}

/** A deliberately restricted JCS profile: integer numbers only; no toJSON, accessors or malformed Unicode. */
export function canonicalJson(input: unknown): string {
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): string => {
    if (depth > 64) throw new Error("Canonical JSON nesting exceeds 64 levels.");
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("Certificates require safe integer numbers.");
      return String(value);
    }
    if (typeof value === "string") return JSON.stringify(scalarString(value));
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("Invalid canonical JSON value.");
    ancestors.add(value);
    let result: string;
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) throw new Error("Sparse or decorated array.");
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Sparse or accessor array.");
        items.push(visit(descriptor.value, depth + 1));
      }
      result = `[${items.join(",")}]`;
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Expected a plain JSON object.");
      if (Object.getOwnPropertySymbols(value).length) throw new Error("Symbol keys are not JSON.");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      result = `{${Object.keys(descriptors).sort().map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Accessors and hidden keys are not JSON.");
        return `${JSON.stringify(scalarString(key))}:${visit(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    }
    ancestors.delete(value);
    return result;
  };
  return visit(input, 0);
}

export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export const certificateDigest = (unsigned: unknown): string => sha256(`cicd-optimizer/cert-v1\0${canonicalJson(unsigned)}`);

export function object(value: Json | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export function string(value: Json | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

export function integer(value: Json | undefined, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in [${min}, ${max}].`);
  return value;
}

export function exactKeys(record: JsonObject, allowed: string[], label: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
