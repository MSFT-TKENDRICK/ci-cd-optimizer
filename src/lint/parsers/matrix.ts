export type MatrixCombination = Record<string, unknown>;

const CAP = 1000;
const primitive = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);
const same = (left: unknown, right: unknown): boolean => primitive(left) && primitive(right) && left === right;

function records(value: unknown): MatrixCombination[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    ? value as MatrixCombination[] : undefined;
}

/** Bounded literal expansion: product, partial excludes, then include merges/appends. */
export function matrixCombinations(matrix: Record<string, unknown>): MatrixCombination[] | undefined {
  try {
    if ("__expression" in matrix || JSON.stringify(matrix).includes("${{")) return undefined;
  } catch {
    return undefined;
  }
  const includes = records(matrix.include);
  const excludes = records(matrix.exclude);
  if (!includes || !excludes) return undefined;
  const dimensions = Object.entries(matrix).filter(([name]) => name !== "include" && name !== "exclude");
  if (dimensions.some(([, values]) => !Array.isArray(values) || values.length === 0)) return undefined;
  const product = dimensions.reduce((total, [, values]) => total * (values as unknown[]).length, 1);
  if (product > CAP || excludes.some((entry) => Object.values(entry).some((value) => !primitive(value)))) return undefined;
  const original = new Set(dimensions.map(([name]) => name));
  if (includes.some((entry) => Object.entries(entry).some(([key, value]) => original.has(key) && !primitive(value)))) return undefined;
  let combinations: MatrixCombination[] = dimensions.length > 0 ? [{}] : [];
  for (const [name, values] of dimensions) {
    combinations = combinations.flatMap((combination) => (values as unknown[]).map((value) => ({ ...combination, [name]: value })));
  }
  combinations = combinations.filter((combination) =>
    !excludes.some((entry) => Object.entries(entry).every(([key, value]) => same(combination[key], value))),
  );
  const base = combinations.length;
  const added: MatrixCombination[] = [];
  for (const entry of includes) {
    let matched = false;
    for (let index = 0; index < base; index += 1) {
      const combination = combinations[index] ?? {};
      if (Object.entries(entry).every(([key, value]) => !original.has(key) || same(combination[key], value))) {
        combinations[index] = { ...combination, ...entry };
        matched = true;
      }
    }
    if (!matched) added.push({ ...entry });
  }
  const all = [...combinations, ...added];
  return all.length <= CAP ? all : undefined;
}

/** Resolve only direct matrix references; functions and other contexts remain unknown. */
export function matrixText(text: string, combination: MatrixCombination): string | undefined {
  let known = true;
  const resolved = text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
    const path = /^matrix((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)$/.exec(expression.trim())?.[1];
    if (!path) {
      known = false;
      return "";
    }
    let value: unknown = combination;
    for (const segment of path.slice(1).split(".")) {
      value = value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as MatrixCombination)[segment] : undefined;
    }
    if (value === undefined || value === null) return "";
    if (!primitive(value)) known = false;
    return String(value);
  });
  return known && !resolved.includes("${{") ? resolved : undefined;
}
