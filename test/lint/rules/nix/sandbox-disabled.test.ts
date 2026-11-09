import { describe, expect, it } from "vitest";
import rule, { sandboxMode, withoutSandboxFlags } from "../../../../src/lint/rules/nix/sandbox-disabled.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31", ...steps);
const installer = (...conf: string[]): string =>
  job("        with:", "          extra_nix_config: |", ...conf.map((line) => `            ${line}`), "      - run: nix build .#app");
const nixFile = (...lines: string[]): Record<string, string> => ({
  ".github/workflows/ci.yml": job("      - run: nix build .#app"),
  "pkgs/foo.nix": yml(...lines),
});
const flake = (...lines: string[]): Record<string, string> => ({
  ".github/workflows/ci.yml": job("      - run: nix flake check"),
  "flake.nix": yml(...lines),
});

describe("sandboxMode", () => {
  it("recognises exactly the weakened values Nix accepts", () => {
    expect(sandboxMode("false")).toBe("false");
    expect(sandboxMode(" relaxed ")).toBe("relaxed");
    expect(sandboxMode("false;")).toBe("false");
    expect(sandboxMode('"relaxed"')).toBe("relaxed");
    expect(sandboxMode("true")).toBeUndefined();
    expect(sandboxMode("$SANDBOX")).toBeUndefined();
    expect(sandboxMode("False")).toBeUndefined();
  });
});

describe("withoutSandboxFlags", () => {
  it("drops only the flags that weaken the sandbox", () => {
    expect(withoutSandboxFlags("nix build --option sandbox false .#app")).toBe("nix build .#app");
    expect(withoutSandboxFlags("nix-build --no-sandbox -A hello")).toBe("nix-build -A hello");
    expect(withoutSandboxFlags("nix build --relaxed-sandbox --extra-option build-use-sandbox 'relaxed' .#a")).toBe("nix build .#a");
    expect(withoutSandboxFlags("nix build --option sandbox-fallback false .#a")).toBe("nix build --option sandbox-fallback false .#a");
  });
});

describe("suggestions", () => {
  it("rewrites the command without the flag and explains fixed-output derivations", () => {
    const [diagnostic] = runRule(rule, { files: job("      - run: nix build --option sandbox false .#app") });
    expect(diagnostic?.suggestion).toContain("run: nix build .#app");
    expect(diagnostic?.suggestion).toContain("extra-sandbox-paths = /path/it/needs");
    expect(diagnostic?.confidence).toBe("high");
    expect(diagnostic?.fix).toBeUndefined();
  });
  it("reports settings inside a composite action a job uses with medium confidence", () => {
    const [diagnostic, ...rest] = runRule(rule, {
      files: {
        ".github/workflows/ci.yml": job("      - uses: ./.github/actions/build"),
        ".github/actions/build/action.yml": yml("name: build", "runs:", "  using: composite", "  steps:", "    - run: nix build --no-sandbox .#app", "      shell: bash"),
      },
    });
    expect(rest).toEqual([]);
    expect(diagnostic?.path).toBe(".github/actions/build/action.yml");
    expect(diagnostic?.line).toBe(5);
    expect(diagnostic?.confidence).toBe("medium");
  });
});

ruleTester(rule, {
  valid: [
    { name: "the sandbox stated explicitly on", files: installer("sandbox = true") },
    { name: "sandbox-fallback is a different setting", files: installer("sandbox-fallback = false") },
    { name: "exposing one host path keeps the sandbox", files: installer("extra-sandbox-paths = /bin/sh") },
    { name: "--sandbox turns it on", files: job("      - run: nix build --sandbox .#app") },
    { name: "a flag that is only printed", files: job('      - run: echo "never pass --no-sandbox"') },
    { name: "a setting that is only printed", files: job('      - run: echo "sandbox = false"') },
    {
      name: "macOS runners default to sandbox = false",
      files: yml("on: push", "jobs:", "  build:", "    runs-on: macos-latest", "    steps:", "      - uses: cachix/install-nix-action@v31", "        with:", "          extra_nix_config: |", "            sandbox = false", "      - run: nix build .#app"),
    },
    {
      name: "a container job cannot create the namespaces anyway",
      files: yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    container: nixos/nix", "    steps:", "      - run: nix build --option sandbox false .#app"),
    },
    { name: "a commented-out __noChroot", files: nixFile("{ stdenv }:", "stdenv.mkDerivation {", '  name = "foo";', "  # __noChroot = true;", "}") },
    { name: "__noChroot = false", files: nixFile("{ stdenv }:", "stdenv.mkDerivation {", '  name = "foo";', "  __noChroot = false;", "}") },
    { name: "__noChroot inside a string", files: nixFile("{ stdenv }:", "stdenv.mkDerivation {", '  name = "foo";', '  passthru.note = "__noChroot = true;";', "}") },
    { name: "flake nixConfig that keeps the sandbox", files: flake("{", "  nixConfig.sandbox = true;", "  outputs = { self }: { };", "}") },
  ],
  invalid: [
    {
      name: "sandbox = false in install-nix-action's extra_nix_config",
      files: installer("max-jobs = auto", "sandbox = false"),
      errors: [{ line: 10, messageIncludes: "`sandbox = false` (set by the `extra_nix_config` input of cachix/install-nix-action) turns the Nix build sandbox off" }],
    },
    {
      name: "sandbox = relaxed in the job's NIX_CONFIG",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      NIX_CONFIG: |",
        "        accept-flake-config = false",
        "        sandbox = relaxed",
        "    steps:",
        "      - uses: cachix/install-nix-action@v31",
        "      - run: nix build .#app",
      ),
      errors: [{ line: 8, messageIncludes: "`sandbox = relaxed` (set by job `NIX_CONFIG`) keeps the sandbox for ordinary builds but builds fixed-output derivations and every derivation that sets `__noChroot = true` outside it" }],
    },
    {
      name: "--option sandbox false on nix build",
      files: job("      - run: nix build --option sandbox false .#app"),
      errors: [{ line: 7, messageIncludes: "`--option sandbox false` (set by the `nix build` command line)" }],
    },
    {
      name: "--no-sandbox on nix-build",
      files: job("      - run: nix-build --no-sandbox -A hello"),
      errors: [{ line: 7, messageIncludes: "`--no-sandbox` (set by the `nix-build` command line)" }],
    },
    {
      name: "--no-sandbox on a build run inside nix develop",
      files: job("      - run: |", "          nix develop -c nix build --no-sandbox .#app"),
      errors: [{ line: 8, messageIncludes: "`--no-sandbox` (set by the `nix build` command line)" }],
    },
    {
      name: "a shell write to nix.conf",
      files: job('      - run: echo "sandbox = false" | sudo tee -a /etc/nix/nix.conf'),
      errors: [{ line: 7, messageIncludes: "(set by a shell write to nix.conf)" }],
    },
    {
      name: "the deprecated build-use-sandbox alias",
      files: installer("build-use-sandbox = false"),
      errors: [{ line: 9, messageIncludes: "`build-use-sandbox = false`" }],
    },
    {
      name: "flake nixConfig.sandbox = false",
      files: flake("{", '  description = "app";', "  nixConfig.sandbox = false;", "  outputs = { self }: { };", "}"),
      errors: [{ line: 3, messageIncludes: "`nixConfig.sandbox = false` in flake.nix asks every consumer of this flake to turn the build sandbox off" }],
    },
    {
      name: "flake nixConfig attrset with sandbox = relaxed",
      files: flake("{", "  nixConfig = {", '    sandbox = "relaxed";', "  };", "  outputs = { self }: { };", "}"),
      errors: [{ line: 3, messageIncludes: "run `__noChroot` and fixed-output derivations outside the build sandbox" }],
    },
    {
      name: "__noChroot = true in a derivation",
      files: nixFile("{ stdenv }:", "stdenv.mkDerivation {", '  name = "foo";', "  __noChroot = true;", "}"),
      errors: [{ line: 4, messageIncludes: "`__noChroot = true` in pkgs/foo.nix asks Nix to build this derivation outside the sandbox" }],
    },
  ],
});
