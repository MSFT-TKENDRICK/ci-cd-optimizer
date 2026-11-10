import { BigNumber } from "bignumber.js";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { CacheKey, Dafny } from "./generated/kernel.js";
import { canonicalJson, scalarString } from "./json.js";
import type { SourceBlob } from "./source.js";

const CONTEXTS = ["sha", "run_id", "run_number", "run_attempt", "ref", "event_name"] as const;
type Context = typeof CONTEXTS[number];
type Dynamic = { kind: "os" } | { kind: "hash"; patterns: string[] } | { kind: "context"; name: Context };
export type Component = { kind: "literal"; value: string } | Dynamic;

export function extractCacheKey(source: SourceBlob, job: string, step: number) {
  const document = parseDocument(source.content, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length || document.warnings.length) throw new Error("Workflow YAML must parse without errors or warnings.");
  visit(document, (_key, node) => {
    if (isAlias(node)) throw new Error("YAML aliases are outside the extraction contract.");
    if (isMap(node) && node.items.some((pair) => isScalar(pair.key) && pair.key.value === "<<")) throw new Error("YAML merge keys are outside the extraction contract.");
  });
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) throw new Error("Workflow must have a literal jobs mapping.");
  const selected = jobs.get(job, true);
  if (!isMap(selected)) throw new Error(`Unknown workflow job: ${job}`);
  const steps = selected.get("steps", true);
  if (!Number.isSafeInteger(step) || step < 0 || !isSeq(steps)) throw new Error("Step must be a nonnegative index in a literal steps array.");
  const action = steps.items[step];
  if (!isMap(action)) throw new Error("Selected step is not a mapping.");
  const uses = action.get("uses", true);
  if (!isScalar(uses) || typeof uses.value !== "string" || !/^actions\/cache(?:\/(?:restore|save))?@[a-zA-Z0-9._/-]+$/.test(uses.value)) {
    throw new Error("Selected step must use a literal actions/cache, actions/cache/restore or actions/cache/save reference.");
  }
  const inputs = action.get("with", true);
  if (!isMap(inputs)) throw new Error("Cache inputs must be a literal mapping.");
  const inputNames = inputs.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("Cache input names must be literal strings.");
    return pair.key.value.toLowerCase();
  });
  if (new Set(inputNames).size !== inputNames.length) throw new Error("Case-colliding cache input names are unsupported.");
  if (inputNames.includes("restore-keys") || inputNames.includes("enablecrossosarchive")) throw new Error("restore-keys and cross-OS archive inputs are outside this model.");
  const key = inputs.get("key", true);
  if (!isScalar(key) || typeof key.value !== "string" || !key.range) throw new Error("Cache key must be a literal YAML string containing only supported expressions.");
  scalarString(key.value);
  const [start, end] = key.range;
  return {
    job, step, uses: uses.value, key: key.value,
    utf8Start: Buffer.byteLength(source.content.slice(0, start), "utf8"),
    utf8End: Buffer.byteLength(source.content.slice(0, end), "utf8"),
    rawKeyBase64: Buffer.from(source.content.slice(start, end), "utf8").toString("base64"),
  };
}

function expression(input: string): Dynamic {
  const text = scalarString(input).trim();
  if (text === "runner.os") return { kind: "os" };
  const name = CONTEXTS.find((context) => text === `github.${context}`);
  if (name) return { kind: "context", name };
  const match = /^hashFiles\s*\(([\s\S]*)\)$/.exec(text);
  if (!match) throw new Error(`Unsupported expression: ${text}`);
  const args = match[1] ?? "";
  const patterns: string[] = [];
  let at = 0;
  const whitespace = () => { while (at < args.length && /\s/u.test(args[at] ?? "")) at += 1; };
  whitespace();
  while (at < args.length) {
    if (args[at++] !== "'") throw new Error("hashFiles arguments must be single-quoted literal strings.");
    let pattern = "";
    let closed = false;
    while (at < args.length) {
      const ch = args[at++];
      if (ch === "'") {
        if (args[at] === "'") { pattern += "'"; at += 1; }
        else { closed = true; break; }
      } else pattern += ch;
    }
    if (!closed) throw new Error("Unterminated hashFiles argument.");
    if (pattern.length > 1024 || patterns.length >= 32) throw new Error("hashFiles argument limit exceeded.");
    patterns.push(pattern);
    whitespace();
    if (at === args.length) break;
    if (args[at++] !== ",") throw new Error("Unexpected hashFiles argument syntax.");
    whitespace();
    if (at === args.length) throw new Error("Trailing hashFiles comma.");
  }
  if (!patterns.length) throw new Error("hashFiles requires at least one literal pattern.");
  return { kind: "hash", patterns };
}

export function parseTemplate(key: string): Component[] {
  scalarString(key);
  if (key.length > 8192) throw new Error("Key template exceeds 8192 UTF-16 code units.");
  const parts: Component[] = [];
  let at = 0;
  while (at < key.length) {
    const opening = key.indexOf("${{", at);
    if (opening < 0) { parts.push({ kind: "literal", value: key.slice(at) }); break; }
    if (opening > at) parts.push({ kind: "literal", value: key.slice(at, opening) });
    let end = opening + 3;
    let quoted = false;
    for (; end < key.length; end += 1) {
      if (key[end] === "'") {
        if (quoted && key[end + 1] === "'") end += 1;
        else quoted = !quoted;
      } else if (!quoted && key.startsWith("}}", end)) break;
    }
    if (end === key.length || quoted) throw new Error("Unterminated cache-key expression.");
    parts.push(expression(key.slice(opening + 3, end)));
    at = end + 2;
  }
  if (parts.length > 128) throw new Error("At most 128 key components.");
  return parts;
}

function nameOf(component: Dynamic): string {
  if (component.kind === "os") return "runner.os";
  if (component.kind === "context") return `github.${component.name}`;
  return `hashFiles(${component.patterns.map((pattern) => `'${pattern.replaceAll("'", "''")}'`).join(",")})`;
}

interface ScalarSequence { toVerbatimString(asLiteral: boolean): string }
interface GeneratedContext { is_Sha: boolean; is_RunId: boolean; is_RunNumber: boolean; is_RunAttempt: boolean; is_Ref: boolean; is_EventName: boolean }
interface GeneratedComponent {
  is_Lit: boolean; is_RunnerOs: boolean; is_HashFiles: boolean; is_Ctx: boolean;
  dtor_s: ScalarSequence; dtor_id: BigNumber; dtor_c: GeneratedContext;
}
interface GeneratedDependency {
  is_DOs: boolean; is_DFiles: boolean; is_DCtx: boolean; dtor_id: BigNumber; dtor_c: GeneratedContext;
}
interface GeneratedVerdict {
  is_Unsupported: boolean; dtor_at: BigNumber; dtor_uncovered: GeneratedDependency[]; dtor_undetermined: GeneratedComponent[];
}

const contextEncode = (name: Context): GeneratedContext => {
  switch (name) {
    case "sha": return CacheKey.CtxVar.create_Sha();
    case "run_id": return CacheKey.CtxVar.create_RunId();
    case "run_number": return CacheKey.CtxVar.create_RunNumber();
    case "run_attempt": return CacheKey.CtxVar.create_RunAttempt();
    case "ref": return CacheKey.CtxVar.create_Ref();
    case "event_name": return CacheKey.CtxVar.create_EventName();
  }
};

function contextDecode(context: GeneratedContext): Context {
  if (context.is_Sha) return "sha";
  if (context.is_RunId) return "run_id";
  if (context.is_RunNumber) return "run_number";
  if (context.is_RunAttempt) return "run_attempt";
  if (context.is_Ref) return "ref";
  if (context.is_EventName) return "event_name";
  throw new Error("Unexpected generated context.");
}

/** Executes the statically bundled Dafny classifier, transformation and counterexample constructors. */
export function analyzeCacheKey(key: string, declared: string[] | null) {
  const parts = parseTemplate(key);
  if (declared && declared.length > 128) throw new Error("At most 128 declared dependencies.");
  const inferred = parts.filter((part): part is Dynamic => part.kind !== "literal")
    .filter((part) => part.kind !== "context" || part.name === "ref" || part.name === "event_name");
  const rawDeps = declared === null ? inferred : declared.map(expression);
  const deps = [...new Map(rawDeps.map((dep) => [nameOf(dep), dep])).values()].sort((a, b) => nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0);
  if (declared && deps.length !== declared.length) throw new Error("Duplicate declared dependency.");
  const dynamics = [...new Map([...parts.filter((part): part is Dynamic => part.kind !== "literal"), ...deps].map((part) => [nameOf(part), part])).values()]
    .sort((a, b) => nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0);
  const hashes = dynamics.filter((part) => part.kind === "hash");
  const hashId = (part: Dynamic) => {
    const id = hashes.findIndex((hash) => nameOf(hash) === nameOf(part));
    if (id < 0) throw new Error("Unknown hashFiles identity.");
    return new BigNumber(id);
  };
  const encode = (part: Component): GeneratedComponent => {
    switch (part.kind) {
      case "literal": return CacheKey.Comp.create_Lit(Dafny.Seq.UnicodeFromString(part.value));
      case "os": return CacheKey.Comp.create_RunnerOs();
      case "hash": return CacheKey.Comp.create_HashFiles(hashId(part));
      case "context": return CacheKey.Comp.create_Ctx(contextEncode(part.name));
    }
  };
  const encodeDep = (dep: Dynamic): GeneratedDependency => {
    switch (dep.kind) {
      case "os": return CacheKey.Dep.create_DOs();
      case "hash": return CacheKey.Dep.create_DFiles(hashId(dep));
      case "context": return CacheKey.Dep.create_DCtx(contextEncode(dep.name));
    }
  };
  const decodeHash = (id: BigNumber): Dynamic => {
    const part = hashes[id.toNumber()];
    if (!part || !id.isInteger() || id.isNegative()) throw new Error("Unexpected generated hashFiles identity.");
    return part;
  };
  const decode = (part: GeneratedComponent): Component => {
    if (part.is_Lit) return { kind: "literal", value: part.dtor_s.toVerbatimString(false) };
    if (part.is_RunnerOs) return { kind: "os" };
    if (part.is_HashFiles) return decodeHash(part.dtor_id);
    if (part.is_Ctx) return { kind: "context", name: contextDecode(part.dtor_c) };
    throw new Error("Unexpected generated component.");
  };
  const decodeDep = (dep: GeneratedDependency): Dynamic => {
    if (dep.is_DOs) return { kind: "os" };
    if (dep.is_DFiles) return decodeHash(dep.dtor_id);
    if (dep.is_DCtx) return { kind: "context", name: contextDecode(dep.dtor_c) };
    throw new Error("Unexpected generated dependency.");
  };
  const template = Dafny.Seq.of(...parts.map(encode));
  const dependencies = Dafny.Seq.of(...deps.map(encodeDep));
  const verdict: GeneratedVerdict = CacheKey.__default.Classify(template, dependencies);
  if (verdict.is_Unsupported) throw new Error(`Key is outside the separated-template model at component ${verdict.dtor_at.toNumber()}.`);
  const normalized: GeneratedComponent[] = CacheKey.__default.Norm(template);
  const recommended: GeneratedComponent[] = CacheKey.__default.Recommend(template, dependencies);
  const recommendedParts = Array.from(recommended, decode);
  const recommendedVerdict: GeneratedVerdict = CacheKey.__default.Classify(recommended, dependencies);
  const normalizedParts = Array.from(normalized, decode);
  let proposedKey: string | null = recommendedParts.map((part) => part.kind === "literal" ? part.value : `\${{ ${nameOf(part)} }}`).join("");
  try {
    const reparsed: GeneratedComponent[] = CacheKey.__default.Norm(Dafny.Seq.of(...parseTemplate(proposedKey).map(encode)));
    if (canonicalJson(Array.from(reparsed, decode)) !== canonicalJson(recommendedParts)) proposedKey = null;
  } catch { proposedKey = null; }
  const base = CacheKey.__default.Base();
  const snapshot = (run: ReturnType<typeof CacheKey.__default.Base>) => dynamics.map((part) => ({
    component: nameOf(part), value: CacheKey.__default.Val(encode(part), run).toVerbatimString(false),
  }));
  const witness = (dep: GeneratedDependency, expectedKeyEqual: boolean) => {
    const varied = CacheKey.__default.Vary(dep);
    const keyEqual: boolean = CacheKey.__default.KeyEq(template, base, varied);
    const dependenciesEqual: boolean = CacheKey.__default.DepsEq(CacheKey.__default.DSet(dependencies), base, varied);
    if (!CacheKey.__default.WF(template, base) || !CacheKey.__default.WF(template, varied) ||
      keyEqual !== expectedKeyEqual || dependenciesEqual === expectedKeyEqual) throw new Error("Generated counterexample failed its runtime postcondition.");
    return {
      varied: nameOf(decodeDep(dep)), left: snapshot(base), right: snapshot(varied),
      leftKey: CacheKey.__default.Render(template, base).toVerbatimString(false),
      rightKey: CacheKey.__default.Render(template, varied).toVerbatimString(false),
      keyEqual, dependenciesEqual,
    };
  };
  return {
    dependencyPolicy: declared === null ? "inferred-excluding-run-contexts" : "declared",
    dependencies: deps.map(nameOf),
    normalized: normalizedParts,
    exactPartition: verdict.dtor_uncovered.length === 0 && verdict.dtor_undetermined.length === 0,
    uncovered: Array.from(verdict.dtor_uncovered, (dep) => witness(dep, true)),
    undetermined: Array.from(verdict.dtor_undetermined, (part) => witness(CacheKey.__default.DepOf(part), false)),
    recommendation: {
      components: recommendedParts, key: proposedKey,
      supported: !recommendedVerdict.is_Unsupported && proposedKey !== null,
      exactPartition: !recommendedVerdict.is_Unsupported && recommendedVerdict.dtor_uncovered.length === 0 && recommendedVerdict.dtor_undetermined.length === 0,
      coarsensOriginalPartition: true,
    },
  };
}

export const CACHE_ASSUMPTIONS = [
  "D denotes only the explicitly declared (or labeled inferred) component values, not the actual dependencies of arbitrary pipeline code.",
  "Abstract runs independently range over the stated domains: OS Linux/Windows/macOS; hashFiles empty or 64 lowercase hex; SHA 40 lowercase hex; run counters nonempty decimal strings; ref/event arbitrary Unicode scalars.",
  "The model concerns primary-key string equality only, not Actions cache scope/version, prefix restore, save races, eviction, hits, speed, or hash collision resistance.",
  "The YAML/expression extractor and JavaScript/Dafny compiler/runtime bridge are trusted code, tested but not formally proved equivalent to GitHub Actions.",
  "A recommendation is a model transformation, not a workflow patch or evidence that removing a context dependency is safe for the workload.",
] as const;
