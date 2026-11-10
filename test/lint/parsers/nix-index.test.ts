import { describe, expect, it } from "vitest";
import { lint } from "../../../src/lint/api.js";
import { matchingClose, nixBindings, nixStructure, parseNix, scopeExprEnd } from "../../../src/lint/parsers/nix.js";
import { buildProject } from "../../../src/lint/project.js";
import { callArgument, calledAttrset, enclosingOpen, inheritStatements, inheritStatementsAt, isLambdaPattern, isShadowed } from "../../../src/lint/rules/nix/expr.js";
import ifdRule from "../../../src/lint/rules/nix/import-from-derivation.js";
import sourceRule from "../../../src/lint/rules/nix/src-whole-repo.js";
import type { AnalysisInput } from "../../../src/lint/types.js";

describe("shared Nix structural index", () => {
  it.each([
    "{ pkgs }: { a = pkgs.stdenv.mkDerivation { name = \"a\"; src = ./src; }; }",
    "{ a ? f { x = 1; }, b ? [ (f {}) ] }@args: { inherit (args) a b; }",
    "{ a = \"[ not code } ${f { name = \"}\"; }}\"; # unmatched }\n b = ''\n [ not code ) ''${literal} ${f { x = 1; }}\n''; }",
    "{ a = /* } ) ] */ { b = [ (1) ]; }; c = let x = 1; in with p; assert true; x; }",
    "let inherit top; in { inherit x; a = { inherit (b) c; nested = (let inherit y; in {}); }; }",
    "{([)]}", "({]}[{}])", "{ a = ({ x = 1; });", ")]}", "{(x)[y]} [z", "{[(]} {})",
  ])("preserves legacy delimiter and enclosing semantics for %s", (source) => {
    const file = parseNix("default.nix", source);
    const inherits = inheritStatements(file);
    expect(inheritStatementsAt(file, -1)).toEqual(inherits.filter((statement) => enclosingOpen(file.masked, statement.offset) === -1));
    for (let offset = 0; offset <= file.masked.length; offset += 1) {
      expect(matchingClose(file, offset), `closing ${offset}`).toBe(matchingClose(file.masked, offset));
      expect(enclosingOpen(file, offset), `enclosing ${offset}`).toBe(enclosingOpen(file.masked, offset));
      expect(isLambdaPattern(file, offset), `lambda ${offset}`).toBe(isLambdaPattern(file.masked, offset));
      expect(inheritStatementsAt(file, offset), `inherit scope ${offset}`).toEqual(
        inherits.filter((statement) => enclosingOpen(file.masked, statement.offset) === offset),
      );
    }
  });

  it("does not validate an outer span across a mismatch, but still recognizes later valid spans", () => {
    const file = parseNix("default.nix", "{ ([)] {} }");
    expect(matchingClose(file, 0)).toBe(-1);
    expect(matchingClose(file, file.masked.indexOf("{}"))).toBe(file.masked.indexOf("{}") + 1);
  });

  it("reuses scope, delimiter, builder, binding and inherit facts without reading source again", () => {
    const source = "{ pkgs }: {\n" + Array.from({ length: 600 }, (_, index) =>
      `  p${index} = pkgs.stdenv.mkDerivation { name="p${index}";src=./src; };\n`,
    ).join("") + `}\n/* ${"trailing comment ".repeat(1000)} */`;
    let sourceReads = 0;
    const file = new Proxy(parseNix("default.nix", source), {
      get(target, key, receiver) {
        if (key === "masked") sourceReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const structure = nixStructure(file);
    const inherits = inheritStatements(file);
    const builders = file.idents.filter((ident) => ident.text === "pkgs.stdenv.mkDerivation");
    expect(builders).toHaveLength(600);
    const facts = builders.map((ident) => {
      const argument = callArgument(file, ident);
      const open = calledAttrset(file, ident);
      expect(argument?.kind).toBe("attrs");
      expect(open).toBe(argument?.start);
      return { ident, argument, open: open!, bindings: nixBindings(file, open!), scoped: inheritStatementsAt(file, open!) };
    });
    expect(sourceReads).toBeGreaterThan(0);
    sourceReads = 0;
    for (const { ident, argument, open, bindings, scoped } of facts) {
      expect(nixStructure(file)).toBe(structure);
      expect(callArgument(file, ident)).toBe(argument);
      expect(calledAttrset(file, ident)).toBe(open);
      expect(nixBindings(file, open)).toBe(bindings);
      expect(inheritStatements(file)).toBe(inherits);
      expect(inheritStatementsAt(file, open)).toBe(scoped);
      expect(matchingClose(file, open)).toBe(argument!.end - 1);
      expect(enclosingOpen(file, ident.offset)).toBe(source.indexOf("{", source.indexOf(":")));
      expect(isLambdaPattern(file, enclosingOpen(file, ident.offset))).toBe(false);
    }
    expect(sourceReads).toBe(0);
    expect(structure.closes.length).toBe(source.length);
    expect(structure.enclosing.length).toBe(source.length + 1);
  });

  it("caches negative builder facts without repeating source reads", () => {
    let sourceReads = 0;
    const file = new Proxy(parseNix("default.nix", "{ mkDerivation = other; inherit mkDerivation; }"), {
      get(target, key, receiver) {
        if (key === "masked") sourceReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const builders = file.idents.filter((ident) => ident.text === "mkDerivation");
    expect(builders).toHaveLength(2);
    for (const ident of builders) expect(calledAttrset(file, ident)).toBeUndefined();
    expect(sourceReads).toBeGreaterThan(0);
    sourceReads = 0;
    for (const ident of builders) {
      expect(callArgument(file, ident)).toBeUndefined();
      expect(calledAttrset(file, ident)).toBeUndefined();
    }
    expect(sourceReads).toBe(0);
  });

  it("reuses positive and negative shadowing facts without crossing parsed files", () => {
    let sourceReads = 0;
    const file = new Proxy(parseNix("default.nix", "{ src }: let inherit (other) fetchTarball; in { builtins = {}; a = builtins.getEnv \"x\"; }"), {
      get(target, key, receiver) {
        if (key === "masked") sourceReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const expected = { src: true, fetchTarball: true, builtins: true, getEnv: false };
    for (const [name, shadowed] of Object.entries(expected)) expect(isShadowed(file, name)).toBe(shadowed);
    expect(sourceReads).toBeGreaterThan(0);
    sourceReads = 0;
    for (const [name, shadowed] of Object.entries(expected)) expect(isShadowed(file, name)).toBe(shadowed);
    expect(sourceReads).toBe(0);
    expect(isShadowed(parseNix("default.nix", "builtins.getEnv \"x\""), "builtins")).toBe(false);
  });

  it("reuses lexical expression tokens without crossing parsed files or mutating input", () => {
    const source = "if enabled then first else second";
    let identifierReads = 0;
    const file = new Proxy(parseNix("default.nix", source), {
      get(target, key, receiver) {
        if (key === "idents") identifierReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    for (let pass = 0; pass < 3; pass += 1) {
      expect(scopeExprEnd(file, 0)).toBe(source.length);
      expect(scopeExprEnd(file, source.indexOf("first"))).toBe(source.indexOf("else"));
    }
    expect(identifierReads).toBe(1);
    expect(file.content).toBe(source);
    expect(file.masked).toBe(source);
    expect(scopeExprEnd(parseNix("default.nix", "first"), 0)).toBe(5);
  });

  it.each([sourceRule, ifdRule].flatMap((rule) =>
    ["body", "siblings", "shadowed-siblings", "consecutive-lets"].map((layout) => ({ rule, layout })),
  ))("$rule.meta.id reuses file-wide source facts for $layout", ({ rule, layout }) => {
    const readsFor = (count: number): number => {
      const builders = Array.from({ length: count }, (_, index) =>
        `  p${index} = pkgs.stdenv.mkDerivation { name="p${index}";inherit src; };\n`,
      ).join("");
      const content = layout === "siblings" ? `{ pkgs }: let\n${builders}src = ./.; in p0`
        : layout === "shadowed-siblings" ? `{ pkgs }: let src = ./.; in { batch = let\n${builders}src = ./src; in p0; }`
          : layout === "consecutive-lets" ? `{ pkgs }: ${"let src = ./.; in ".repeat(count)}pkgs.stdenv.mkDerivation { inherit src; }`
            : `{ pkgs }: let src = ./.; in {\n${builders}}`;
      const input: AnalysisInput = { files: [{ path: "default.nix", content }], mode: "repository", inventoryComplete: true };
      const project = buildProject(input);
      let sourceReads = 0;
      const file = new Proxy(project.nix.files[0]!, {
        get(target, key, receiver) {
          if (key === "masked") sourceReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      project.nix.files[0] = file;
      nixStructure(file);
      isShadowed(file, "builtins");
      for (const ident of file.idents) {
        if (ident.text !== "pkgs.stdenv.mkDerivation") continue;
        const open = calledAttrset(file, ident)!;
        nixBindings(file, open);
        expect(inheritStatementsAt(file, open)).toHaveLength(1);
      }
      sourceReads = 0;
      let reports = 0;
      rule.check({ input, project, options: { allow: [] }, report: () => { reports += 1; } });
      expect(reports).toBe(rule === sourceRule && layout !== "shadowed-siblings" ? layout === "consecutive-lets" ? 1 : count : 0);
      return sourceReads;
    };
    const first = readsFor(1);
    expect(first).toBeGreaterThan(0);
    expect(readsFor(600)).toBe(first);
  });

  it("isolates cached facts by parsed file and keeps caller prefixes out of cached bindings", () => {
    const first = parseNix("default.nix", "{ a = { b = 1; }; }");
    const second = parseNix("default.nix", "{ c = 2; }");
    const bindings = nixBindings(first, 0);
    expect(nixBindings(first, 0, ["outer"]).map((binding) => binding.path)).toEqual([["outer", "a"], ["outer", "a", "b"]]);
    expect(bindings.map((binding) => binding.path)).toEqual([["a"], ["a", "b"]]);
    expect(nixBindings(first, 0)).toBe(bindings);
    expect(nixBindings(second, 0).map((binding) => binding.path)).toEqual([["c"]]);
    expect(nixStructure(first)).not.toBe(nixStructure(second));
    expect(matchingClose(first, 0)).not.toBe(matchingClose(second, 0));
  });

  it.each([600, 1200, 2400])("keeps default public-API analysis clean for %i sibling derivations", (count) => {
    const content = "{ pkgs }: {\n" + Array.from({ length: count }, (_, index) =>
      `  p${index} = pkgs.stdenv.mkDerivation { name="p${index}";src=./src; };\n`,
    ).join("") + "}";
    expect(Buffer.byteLength(content)).toBeLessThan(512_000);
    const result = lint({ input: { files: [{ path: "default.nix", content }], mode: "repository", inventoryComplete: true } });
    expect(result.diagnostics).toEqual([]);
    expect(result.parseProblems).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason.includes("crashed"))).toBe(false);
    expect(result.rulesRun).toBeGreaterThan(0);
  });

  it.each([600, 1200, 2400])("keeps default public-API analysis clean for %i inherited-source derivations", (count) => {
    const content = "{ pkgs }: let src = ./src; in {\n" + Array.from({ length: count }, (_, index) =>
      ` p${index} = pkgs.stdenv.mkDerivation { name="p${index}";inherit src; };\n`,
    ).join("") + "}";
    expect(Buffer.byteLength(content)).toBeLessThan(512_000);
    const result = lint({ input: { files: [{ path: "default.nix", content }], mode: "repository", inventoryComplete: true } });
    expect(result.diagnostics).toEqual([]);
    expect(result.parseProblems).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason.includes("crashed"))).toBe(false);
    expect(result.rulesRun).toBeGreaterThan(0);
  });

  it.each([600, 1200, 2400])("keeps default public-API analysis clean for %i recursively shadowed sibling derivations", (count) => {
    const content = "{ pkgs }: let src = ./.; in { batch = let\n" + Array.from({ length: count }, (_, index) =>
      ` p${index} = pkgs.stdenv.mkDerivation { name="p${index}";inherit src; };\n`,
    ).join("") + "src = ./src; in p0; }";
    expect(Buffer.byteLength(content)).toBeLessThan(512_000);
    const result = lint({ input: { files: [{ path: "default.nix", content }], mode: "repository", inventoryComplete: true } });
    expect(result.diagnostics).toEqual([]);
    expect(result.parseProblems).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason.includes("crashed"))).toBe(false);
    expect(result.rulesRun).toBeGreaterThan(0);
  });
});
