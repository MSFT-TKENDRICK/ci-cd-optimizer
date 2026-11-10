import { describe, expect, it } from "vitest";
import { buildProject } from "../../src/lint/project.js";
import type { AnalysisInput } from "../../src/lint/types.js";
import { toFiles } from "./rule-tester.js";

function project(files: Record<string, string>, extra: Partial<AnalysisInput> = {}) {
  return buildProject({ files: toFiles(files), mode: "repository", inventoryComplete: true, ...extra });
}

const FLAKE = `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  outputs = { self, nixpkgs }: { };
}
`;

const LOCK = JSON.stringify(
  {
    nodes: {
      nixpkgs: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "abc", lastModified: 1 } },
      root: { inputs: { nixpkgs: "nixpkgs" } },
    },
    root: "root",
    version: 7,
  },
  null,
  2,
);

describe("buildProject nix model", () => {
  it("groups flake.nix and flake.lock by directory", () => {
    const model = project({ "flake.nix": FLAKE, "flake.lock": LOCK, "tools/flake.nix": FLAKE, "nix/pkgs.nix": "{ }\n" });
    expect(model.nix.files.map((file) => file.path).sort()).toEqual(["flake.nix", "nix/pkgs.nix", "tools/flake.nix"]);
    expect(model.nix.locks.map((lock) => lock.path)).toEqual(["flake.lock"]);
    expect(model.nix.flakes.map((flake) => [flake.dir, !!flake.nix, !!flake.lock])).toEqual([
      ["", true, true],
      ["tools", true, false],
    ]);
    expect([...(model.nix.flakes[0]?.info?.inputs.keys() ?? [])]).toEqual(["nixpkgs"]);
    expect(model.facts.usesNix).toEqual({ status: "known", value: true });
  });

  it("reports malformed flake.lock as a parse problem", () => {
    const model = project({ "flake.lock": "{ not json" });
    expect(model.parseProblems).toHaveLength(1);
    expect(model.parseProblems[0]?.path).toBe("flake.lock");
    expect(model.facts.usesNix.value).toBe(false);
  });

  it.each([
    ["installer action", "      - uses: cachix/install-nix-action@v31\n"],
    ["nix run command", "      - run: nix build .#app\n"],
    ["nix-build command", "      - run: |\n          echo hi\n          nix-build default.nix\n"],
    ["nix develop shell", "      - run: make\n        shell: nix develop --command bash -e {0}\n"],
  ])("detects Nix in workflows via %s", (_name, step) => {
    const model = project({
      ".github/workflows/ci.yml": `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${step}`,
    });
    expect(model.facts.usesNix).toEqual({ status: "known", value: true });
  });

  it("does not treat words containing nix as Nix usage", () => {
    const model = project({
      ".github/workflows/ci.yml": "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo unix phoenix\n",
    });
    expect(model.facts.usesNix).toEqual({ status: "known", value: false });
  });

  it("is unknown when the inventory is incomplete and nothing was found", () => {
    const model = project({ "README.md": "x" }, { inventoryComplete: false });
    expect(model.facts.usesNix.status).toBe("unknown");
  });
});
