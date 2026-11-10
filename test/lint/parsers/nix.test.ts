import { describe, expect, it } from "vitest";
import {
  argumentAfter,
  bindingString,
  exprEnd,
  flakeInfo,
  identsNamed,
  lexNix,
  nixBindings,
  parseFlakeLock,
  parseFlakeRef,
  parseNix,
  resolveLockInput,
  scopeExprEnd,
  searchPaths,
  topLevelAttrset,
} from "../../../src/lint/parsers/nix.js";

const FLAKE = `{
  description = "demo # not a comment";

  # inputs.ignored.url = "github:nope/nope";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
    crane = {
      url = "github:ipetkov/crane";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    src-only = { url = "github:example/data"; flake = false; };
  };
  inputs.registry.url = "nixpkgs";

  nixConfig = {
    extra-substituters = [ "https://cache.example.org" ];
    extra-trusted-public-keys = [ "cache.example.org-1:abc=" ];
  };

  outputs = { self, nixpkgs, flake-utils, crane, home-manager, ... }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs { inherit system; };
    in { packages.default = pkgs.hello; });
}
`;

describe("nix lexer", () => {
  it("masks comments and literal string text while keeping offsets and newlines", () => {
    const source = 'x = "a # b"; # trailing\n/* block\n */ y = 1;';
    const { masked, strings } = lexNix(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("trailing");
    expect(masked).not.toContain("block");
    expect(masked).not.toContain("a # b");
    expect(masked).toContain("y = 1;");
    expect(strings).toEqual([{ start: 4, end: 11, value: "a # b", interpolated: false, indented: false }]);
  });

  it("keeps interpolated code visible and records nested strings", () => {
    const source = 'url = "https://x/${builtins.toString "v"}/y"; z = 1;';
    const file = parseNix("default.nix", source);
    expect(file.masked).toContain("builtins.toString");
    expect(file.strings.map((string) => string.value)).toEqual(['https://x/${builtins.toString "v"}/y', "v"]);
    expect(file.strings[0]?.interpolated).toBe(true);
    expect(identsNamed(file, "builtins.toString")).toHaveLength(1);
  });

  it("handles indented strings, their escapes, and identifiers containing quotes", () => {
    const source = "a' = 1; s = ''\n  echo '''quoted''' ''${HOME} ''\\n ${pkgs.hello}\n''; b = a';";
    const file = parseNix("x.nix", source);
    const indented = file.strings.find((string) => string.indented);
    expect(indented?.interpolated).toBe(true);
    expect(file.masked).toContain("pkgs.hello");
    expect(file.masked).not.toContain("echo");
    expect(file.masked).not.toContain("HOME");
    expect(file.masked).toContain("b = a';");
  });

  it("ignores path literals and search paths when collecting identifiers", () => {
    const source = "{ a = ./foo/bar.nix; b = import <nixpkgs> {}; c = fetchTarball; }";
    const file = parseNix("x.nix", source);
    const names = file.idents.map((ident) => ident.text);
    expect(names).toContain("fetchTarball");
    expect(names).not.toContain("foo");
    expect(names).not.toContain("bar.nix");
    expect(names).not.toContain("nixpkgs");
    expect(searchPaths(file)).toEqual([{ name: "nixpkgs", offset: source.indexOf("<"), line: 1 }]);
  });

  it("reports 1-based lines", () => {
    const file = parseNix("x.nix", "{\n  a = 1;\n\n  b = fetchurl;\n}");
    expect(identsNamed(file, "fetchurl")[0]?.line).toBe(4);
    expect(file.lineOf(0)).toBe(1);
  });
});

describe("nix structure helpers", () => {
  it("finds expression ends across let/in, with and nested brackets", () => {
    const masked = parseNix("x.nix", "a = let b = 1; in { c = [ 1 2 ]; }; d = 2;").masked;
    expect(exprEnd(masked, 4)).toBe(masked.indexOf("; d"));
    const withSource = parseNix("x.nix", "a = with pkgs; [ hello ]; b = 1;").masked;
    expect(exprEnd(withSource, 4)).toBe(withSource.indexOf("; b"));
  });

  it.each([
    "0", "./if", "if/foo", "<if>", "pkgs.if", "./let", "<with>",
    'let { body = "if then else"; }',
    'let local = if enabled then "a" else "b"; in local',
    "with pkgs; assert enabled; if nested then ./then else pkgs.else",
    "if if nested then enabled else false then [ (if true then 1 else 2) ] else {}",
    '"literal if then else ${if enabled then ./if else ./else}"',
  ])("ends a lexical body at its enclosing else after %s", (body) => {
    const prefix = "a = if enabled then let local = 1; in ";
    const content = `${prefix}${body} else outside; next = 0;`;
    const file = parseNix("default.nix", content);
    expect(scopeExprEnd(file, prefix.length)).toBe(prefix.length + body.length + 1);
  });

  it("ends a lexical condition before its enclosing then without changing legacy expression scans", () => {
    const prefix = "if let src = ./.; in ";
    const body = "with pkgs; if enabled then true else false";
    const file = parseNix("default.nix", `${prefix}${body} then first else second; next = 0;`);
    expect(scopeExprEnd(file, prefix.length)).toBe(prefix.length + body.length + 1);
    expect(exprEnd(file.masked, prefix.length)).toBe(file.masked.indexOf("; next"));
  });

  it("classifies call arguments", () => {
    const file = parseNix("x.nix", 'fetchTarball { url = "u"; } fetchTarball "u" f (x) g [ 1 ] h y');
    const kinds = file.idents
      .filter((ident) => ["fetchTarball", "f", "g", "h"].includes(ident.text))
      .map((ident) => argumentAfter(file, ident.end)?.kind);
    expect(kinds).toEqual(["attrs", "string", "paren", "list", "other"]);
  });

  it("flattens nested bindings but not function patterns", () => {
    const file = parseNix("flake.nix", FLAKE);
    const open = topLevelAttrset(file);
    expect(open).toBe(0);
    const paths = nixBindings(file, open ?? 0).map((binding) => binding.path.join("."));
    expect(paths).toContain("inputs.nixpkgs.url");
    expect(paths).toContain("inputs.crane.inputs.nixpkgs.follows");
    expect(paths).toContain("inputs.src-only.flake");
    expect(paths).not.toContain("inputs.ignored.url");
    expect(paths).not.toContain("outputs.self");
    const description = nixBindings(file, 0).find((binding) => binding.path[0] === "description");
    expect(description && bindingString(file, description)).toBe("demo # not a comment");
  });

  it("skips inherit clauses", () => {
    const file = parseNix("x.nix", "{ inherit (pkgs) hello; inherit system; name = \"x\"; }");
    expect(nixBindings(file, 0).map((binding) => binding.path.join("."))).toEqual(["name"]);
  });

  it("does not treat a function file as a top-level attribute set", () => {
    expect(topLevelAttrset(parseNix("default.nix", "{ pkgs ? import <nixpkgs> {} }: pkgs.hello"))).toBeUndefined();
    expect(topLevelAttrset(parseNix("default.nix", "{ pkgs, ... }@args: pkgs.hello"))).toBeUndefined();
  });
});

describe("flake.nix", () => {
  it("summarises inputs, nixConfig and outputs", () => {
    const info = flakeInfo(parseNix("flake.nix", FLAKE));
    expect(info?.description).toBe("demo # not a comment");
    expect([...(info?.inputs.keys() ?? [])]).toEqual(["nixpkgs", "flake-utils", "crane", "src-only", "registry"]);
    expect(info?.inputs.get("nixpkgs")).toMatchObject({
      url: "github:NixOS/nixpkgs/nixos-24.11",
      urlLine: 6,
      flakeRef: { type: "github", owner: "NixOS", repo: "nixpkgs", ref: "nixos-24.11" },
    });
    expect(info?.inputs.get("crane")?.nestedFollows.get("nixpkgs")).toBe("nixpkgs");
    expect(info?.inputs.get("crane")?.line).toBe(8);
    expect(info?.inputs.get("src-only")?.flake).toBe(false);
    expect(info?.inputs.get("registry")?.flakeRef).toMatchObject({ type: "indirect", id: "nixpkgs" });
    expect(info?.nixConfig.get("extra-substituters")?.values).toEqual(["https://cache.example.org"]);
    expect(info?.outputs).toMatchObject({ args: ["self", "nixpkgs", "flake-utils", "crane", "home-manager"], open: true });
  });

  it("reads attribute-style inputs and single-argument outputs", () => {
    const info = flakeInfo(
      parseNix(
        "flake.nix",
        '{ inputs.nixpkgs = { type = "github"; owner = "NixOS"; repo = "nixpkgs"; ref = "nixos-unstable"; }; outputs = inputs: { }; }',
      ),
    );
    expect(info?.inputs.get("nixpkgs")?.flakeRef).toEqual({
      type: "github",
      owner: "NixOS",
      repo: "nixpkgs",
      ref: "nixos-unstable",
    });
    expect(info?.outputs).toMatchObject({ args: [], open: true });
  });

  it("keeps the id of an attribute-style indirect input", () => {
    const info = flakeInfo(
      parseNix("flake.nix", '{ inputs.pkgs = { type = "indirect"; id = "nixpkgs"; ref = "nixos-24.11"; }; outputs = _: { }; }'),
    );
    expect(info?.inputs.get("pkgs")?.flakeRef).toEqual({ type: "indirect", id: "nixpkgs", ref: "nixos-24.11" });
  });

  it("returns undefined for a non-attribute-set file", () => {
    expect(flakeInfo(parseNix("flake.nix", "import ./flake-impl.nix"))).toBeUndefined();
  });
});

describe("flake references", () => {
  it.each([
    ["github:NixOS/nixpkgs", { type: "github", owner: "NixOS", repo: "nixpkgs" }],
    ["github:NixOS/nixpkgs/nixos-unstable", { type: "github", ref: "nixos-unstable" }],
    ["github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567", { rev: "0123456789abcdef0123456789abcdef01234567" }],
    ["github:NixOS/nixpkgs?ref=master&dir=lib", { ref: "master", dir: "lib" }],
    ["git+https://github.com/NixOS/nixpkgs?ref=nixos-24.11", { type: "git", host: "github.com", ref: "nixos-24.11" }],
    ["git+ssh://git@example.com/repo", { type: "git", host: "example.com" }],
    ["path:./sub", { type: "path" }],
    ["./sub", { type: "path" }],
    ["https://example.com/x.tar.gz", { type: "tarball", host: "example.com" }],
    ["nixpkgs", { type: "indirect", id: "nixpkgs" }],
    ["flake:nixpkgs/nixos-24.11", { type: "indirect", id: "nixpkgs", ref: "nixos-24.11" }],
    ["gitlab:group/project", { type: "gitlab", owner: "group", repo: "project" }],
  ])("parses %s", (url, expected) => {
    expect(parseFlakeRef(url)).toMatchObject(expected);
  });
});

describe("flake.lock", () => {
  const LOCK = JSON.stringify(
    {
      nodes: {
        crane: {
          inputs: { nixpkgs: ["nixpkgs"] },
          locked: { lastModified: 1700000000, owner: "ipetkov", repo: "crane", rev: "a".repeat(40), type: "github" },
          original: { owner: "ipetkov", repo: "crane", type: "github" },
        },
        nixpkgs: {
          locked: {
            lastModified: 1710000000,
            narHash: "sha256-x",
            owner: "NixOS",
            repo: "nixpkgs",
            rev: "b".repeat(40),
            type: "github",
          },
          original: { owner: "NixOS", ref: "nixos-24.11", repo: "nixpkgs", type: "github" },
        },
        nixpkgs_2: {
          locked: { lastModified: 1690000000, owner: "NixOS", repo: "nixpkgs", rev: "c".repeat(40), type: "github" },
          original: { owner: "NixOS", ref: "nixpkgs-unstable", repo: "nixpkgs", type: "github" },
        },
        root: { inputs: { crane: "crane", nixpkgs: "nixpkgs" } },
      },
      root: "root",
      version: 7,
    },
    null,
    2,
  );

  it("parses nodes with line numbers and resolves follows paths", () => {
    const lock = parseFlakeLock("sub/flake.lock", LOCK);
    expect(lock.dir).toBe("sub");
    expect(lock.version).toBe(7);
    expect(Object.keys(lock.rootInputs)).toEqual(["crane", "nixpkgs"]);
    expect([...lock.nodes.keys()]).toEqual(["crane", "nixpkgs", "nixpkgs_2", "root"]);
    for (const name of ["crane", "nixpkgs", "nixpkgs_2", "root"]) {
      const line = lock.nodes.get(name)?.line ?? 0;
      expect(LOCK.split("\n")[line - 1]).toContain(`"${name}": {`);
    }
    expect(resolveLockInput(lock, "nixpkgs")?.name).toBe("nixpkgs");
    expect(resolveLockInput(lock, ["nixpkgs"])?.name).toBe("nixpkgs");
    expect(resolveLockInput(lock, lock.nodes.get("crane")?.inputs.nixpkgs ?? "")?.name).toBe("nixpkgs");
    expect(resolveLockInput(lock, ["missing"])).toBeUndefined();
  });

  it("throws on malformed JSON", () => {
    expect(() => parseFlakeLock("flake.lock", "{ nope")).toThrow();
  });
});
