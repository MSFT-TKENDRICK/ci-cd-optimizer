import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  visit,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml";

export type Origin = "direct" | "alias" | "merge";
export type ValueKind = "literal" | "expression" | "interpolated";

export interface YamlSource {
  path: string;
  doc: Document.Parsed;
  lineCounter: LineCounter;
  /** Line ranges (1-based, inclusive) occupied by block scalar content such as `run: |` scripts. */
  blockScalarLines: Array<[number, number]>;
}

export interface Field {
  key: string;
  value: Node | null;
  /** Line of the key that declares this value (the anchor definition for merged values). */
  line: number;
  origin: Origin;
}

const MAX_ALIAS_DEPTH = 16;

export function parseYaml(path: string, content: string): YamlSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(content, {
    lineCounter,
    merge: true,
    uniqueKeys: false,
    prettyErrors: true,
    strict: false,
  });
  const blockScalarLines: Array<[number, number]> = [];
  visit(doc, {
    Scalar(_key, node) {
      if (
        (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED) &&
        node.range
      ) {
        const start = lineCounter.linePos(node.range[0]).line;
        const end = lineCounter.linePos(Math.max(node.range[0], node.range[1] - 1)).line;
        blockScalarLines.push([start, end]);
      }
    },
  });
  return { path, doc, lineCounter, blockScalarLines };
}

export function lineOfNode(source: YamlSource, node: Node | null | undefined): number {
  if (!node?.range) return 1;
  return source.lineCounter.linePos(node.range[0]).line;
}

export function columnOfNode(source: YamlSource, node: Node | null | undefined): number {
  if (!node?.range) return 1;
  return source.lineCounter.linePos(node.range[0]).col;
}

export function resolveNode(
  source: YamlSource,
  node: unknown,
): { node: Node | null; viaAlias: boolean } {
  let current = node;
  let viaAlias = false;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH && isAlias(current); depth += 1) {
    viaAlias = true;
    current = current.resolve(source.doc) ?? null;
  }
  if (isAlias(current)) return { node: null, viaAlias };
  return { node: (current as Node | null) ?? null, viaAlias };
}

function isMergeKey(key: unknown): boolean {
  if (isScalar(key)) return key.value === "<<" || key.source === "<<";
  return key === "<<";
}

function keyName(key: unknown): string | undefined {
  if (isScalar(key)) {
    const value = key.value;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;
  }
  return typeof key === "string" ? key : undefined;
}

/** Returns the entries of a mapping, including values contributed by YAML merge keys (`<<: *anchor`). */
export function entries(source: YamlSource, node: unknown): Field[] {
  const { node: mapNode } = resolveNode(source, node);
  if (!isMap(mapNode)) return [];
  const direct: Field[] = [];
  const merged: Field[] = [];
  for (const pair of mapNode.items) {
    if (!isPair(pair)) continue;
    if (isMergeKey(pair.key)) {
      const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
      for (const item of sources) {
        for (const field of entries(source, item)) {
          merged.push({ ...field, origin: "merge" });
        }
      }
      continue;
    }
    const name = keyName(pair.key);
    if (name === undefined) continue;
    const resolved = resolveNode(source, pair.value);
    direct.push({
      key: name,
      value: resolved.node,
      line: lineOfNode(source, pair.key as Node),
      origin: resolved.viaAlias ? "alias" : "direct",
    });
  }
  const seen = new Set(direct.map((field) => field.key));
  for (const field of merged) {
    if (!seen.has(field.key)) {
      seen.add(field.key);
      direct.push(field);
    }
  }
  return direct;
}

export function field(source: YamlSource, node: unknown, key: string): Field | undefined {
  return entries(source, node).find((entry) => entry.key === key);
}

export function items(source: YamlSource, node: unknown): Node[] {
  const { node: seqNode } = resolveNode(source, node);
  if (!isSeq(seqNode)) return [];
  return seqNode.items
    .map((item) => resolveNode(source, item).node)
    .filter((item): item is Node => item !== null);
}

export function scalarValue(node: Node | null | undefined): string | number | boolean | null | undefined {
  if (!isScalar(node)) return undefined;
  const value = node.value;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

export function stringValue(node: Node | null | undefined): string | undefined {
  const value = scalarValue(node);
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export function toJS(source: YamlSource, node: Node | null | undefined): unknown {
  if (!node) return undefined;
  return node.toJS(source.doc, { maxAliasCount: 100 });
}

export function classify(value: unknown): ValueKind {
  if (typeof value !== "string") return "literal";
  const trimmed = value.trim();
  if (/^\$\{\{[\s\S]*\}\}$/.test(trimmed) && trimmed.indexOf("${{", 3) === -1) return "expression";
  return trimmed.includes("${{") ? "interpolated" : "literal";
}

export function isMapNode(node: unknown): node is YAMLMap {
  return isMap(node);
}

export function parseErrors(source: YamlSource): Array<{ line: number; message: string }> {
  return source.doc.errors.map((error) => ({
    line: error.linePos?.[0]?.line ?? 1,
    message: error.message.split("\n")[0] ?? error.message,
  }));
}
