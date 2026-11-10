import { describe, expect, it } from "vitest";
import type { AnyRule } from "../../../../src/lint/types.js";
import accept from "../../../../src/lint/rules/nix/accept-flake-config-untrusted.js";
import currentSystem from "../../../../src/lint/rules/nix/current-system-builtin.js";
import fetchGit from "../../../../src/lint/rules/nix/fetchgit-missing-rev.js";
import fetchTarball from "../../../../src/lint/rules/nix/fetchtarball-no-hash.js";
import getEnv from "../../../../src/lint/rules/nix/get-env-builtin.js";
import maxJobs from "../../../../src/lint/rules/nix/max-jobs-pinned-low.js";
import quick from "../../../../src/lint/rules/nix/quick-install-implicit-flake-config-trust.js";
import sandbox, { withoutSandboxFlags } from "../../../../src/lint/rules/nix/sandbox-disabled.js";
import { cliConf, nixInvocation, shellConfWrites } from "../../../../src/lint/rules/nix/shared.js";
import { runRule } from "../../rule-tester.js";

const WORKFLOW = ".github/workflows/ci.yml";
const INSTALL = "      - uses: cachix/install-nix-action@v31";
const workflow = (trigger: string, ...steps: string[]): string => [
  `on: ${trigger}`, "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps, "",
].join("\n");
const trustedInstaller = [INSTALL, "        with:", "          extra_nix_config: accept-flake-config = true"];
const count = (rule: AnyRule, text: string, expected: number): void => {
  const diagnostics = runRule(rule, { files: text });
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toHaveLength(expected);
  expect(diagnostics.every((diagnostic) => diagnostic.fix === undefined)).toBe(true);
};

describe("recognizable builtin shadowing is not assigned builtin semantics", () => {
  it.each([
    [currentSystem, 'let builtins = { currentSystem = "test"; }; in builtins.currentSystem'],
    [currentSystem, 'let builtins.currentSystem = "test"; in builtins.currentSystem'],
    [currentSystem, 'let __currentSystem = "test"; in __currentSystem'],
    [currentSystem, 'builtins: { inherit (builtins) currentSystem; }'],
    [getEnv, 'builtins: builtins.getEnv "TOKEN"'],
    [getEnv, 'let __getEnv = value: value; in __getEnv "TOKEN"'],
    [getEnv, 'let builtins.getEnv = value: value; inherit (builtins) getEnv; in getEnv "TOKEN"'],
    [fetchGit, 'let builtins.fetchGit = value: value; in builtins.fetchGit "https://example.com/repo.git"'],
    [fetchTarball, 'builtins: builtins.fetchTarball "https://example.com/source.tar.gz"'],
  ] as const)("%s does not assume a rebound name is builtin", (rule, source) => {
    expect(runRule(rule, { files: { "default.nix": source } })).toEqual([]);
  });
});

describe("Nix command and config boundaries", () => {
  it("finds options after installables, but not after -- or in option values", () => {
    const config = (command: string): string[] => {
      const invocation = nixInvocation(command, 1);
      return invocation ? cliConf(invocation, WORKFLOW).map((setting) => `${setting.key}=${setting.value}`) : [];
    };
    expect(config("nix run .#app --no-sandbox")).toEqual(["sandbox=false"]);
    expect(config("nix run .#app -- --no-sandbox")).toEqual([]);
    expect(config("nix build --argstr message --no-sandbox .#app")).toEqual([]);
    expect(config("nix build --option builders '--no-sandbox' .#app")).toEqual(["builders=--no-sandbox"]);
  });

  it.each(['nix build "$FLAGS" --no-sandbox', "nix build $(printf -- --no-sandbox)", "nix build .#${{ matrix.pkg }}"])(
    "leaves dynamic flag positions unknown: %s", (command) => expect(nixInvocation(command, 1)).toBeUndefined(),
  );

  it("retains fully single-quoted literal dollar arguments", () => {
    expect(nixInvocation("nix build --argstr value '$literal' .#app", 1)?.args).toContain("$literal");
  });

  it.each([
    ["~/.config/nix/nix.conf", 1], ['"~/.config/nix/nix.conf"', 0],
    ["'$HOME/.config/nix/nix.conf'", 0], ['"$HOME/.config/nix/nix.conf"', 1],
    ['"${HOME}/.config/nix/nix.conf"', 1], ["./examples/nix.conf", 0],
  ] as const)("respects shell expansion in config destination %s", (path, expected) => {
    expect(shellConfWrites(`echo 'sandbox = false' >> ${path}`, WORKFLOW, 1)).toHaveLength(expected);
  });

  it("does not mistake quoted redirects for writes", () => {
    expect(shellConfWrites('echo "sandbox = false >> /etc/nix/nix.conf"', WORKFLOW, 1)).toEqual([]);
  });

  it("preserves unrelated quoted data, wrapper text and passthrough arguments in manual suggestions", () => {
    const command = `LABEL="--no-sandbox" env FOO=1 "nix" build --argstr note '--no-sandbox' --no-sandbox .#app`;
    const result = `LABEL="--no-sandbox" env FOO=1 "nix" build --argstr note '--no-sandbox' .#app`;
    expect(withoutSandboxFlags(command)).toBe(result);
    expect(withoutSandboxFlags(result)).toBe(result);
    expect(withoutSandboxFlags("nix run .#app -- --no-sandbox")).toBe("nix run .#app -- --no-sandbox");
    expect(withoutSandboxFlags("nix develop -c other-tool --no-sandbox")).toBe("nix develop -c other-tool --no-sandbox");
  });

  it("does not transfer per-command cores or a higher max-jobs limit to another invocation", () => {
    count(maxJobs, workflow("push", INSTALL, "      - run: nix build .#first -j 4 --cores 2", "      - run: nix build .#second -j 1"), 1);
    count(maxJobs, workflow("push", INSTALL, "      - run: nix build .#first -j 1 --cores 2"), 0);
  });
});

describe("flake trust follows chronology and scope", () => {
  it.each([
    ["later installer settings do not govern an earlier command", ["      - run: nix build .#app", ...trustedInstaller], 0],
    ["one rejecting invocation does not reject another", [...trustedInstaller, "      - run: nix build --no-accept-flake-config .#first", "      - run: nix build .#second"], 1],
    ["one accepting invocation does not affect the next", [INSTALL, "      - run: nix build --accept-flake-config .#first", "      - run: nix build .#second"], 1],
    ["later config writes do not remove an earlier decision", [...trustedInstaller, "      - run: nix build .#app", "      - run: echo 'accept-flake-config = false' >> /etc/nix/nix.conf"], 1],
    ["a preceding literal append changes the effective decision", [...trustedInstaller, "      - run: echo 'accept-flake-config = false' >> /etc/nix/nix.conf", "      - run: nix build .#app"], 0],
    ["a conditional write makes configuration unknown", [...trustedInstaller, "      - run: echo 'accept-flake-config = false' >> /etc/nix/nix.conf", "        if: inputs.reject", "      - run: nix build .#app"], 0],
    ["external environment-file content is unknown", [...trustedInstaller, '      - run: cat policy.env >> "$GITHUB_ENV"', "      - run: nix build .#app"], 0],
    ["opaque exports are not assumed irrelevant", [...trustedInstaller, "      - run: |", "          export NIX_CONFIG=$(get-policy)", "          nix build .#app"], 0],
    ["exported config search paths change the boundary", [...trustedInstaller, "      - run: |", "          export HOME=/another-home", "          nix build .#app"], 0],
    ["environment wrapper options are unknown", [...trustedInstaller, "      - run: env -u HOME nix build .#app"], 0],
    ["sourced policy is unknown", [...trustedInstaller, "      - run: |", "          source policy.sh", "          nix build .#app"], 0],
    ["includes require external resolution", [INSTALL, "        with:", "          extra_nix_config: |", "            include another.conf", "            accept-flake-config = true", "      - run: nix build .#app"], 0],
    ["multiple installations are not conflated", [...trustedInstaller, "      - uses: nixbuild/nix-quick-install-action@v35", "      - run: nix build .#app"], 0],
    ["a nested child does not inherit an assumed outer NIX_CONFIG", [...trustedInstaller, "      - run: nix develop --no-accept-flake-config -c env NIX_CONFIG='accept-flake-config=false' nix build .#app"], 0],
  ] as const)("%s", (_name, steps, expected) => count(accept, workflow("pull_request", ...steps), expected));

  it("does not transfer trust across separate invocations of a local composite action", () => {
    const diagnostics = runRule(accept, {
      files: {
        [WORKFLOW]: workflow("pull_request", INSTALL,
          "      - uses: ./.github/actions/build", "        env:", "          NIX_CONFIG: accept-flake-config = true",
          "      - uses: ./.github/actions/build", "        env:", "          NIX_CONFIG: accept-flake-config = false"),
        ".github/actions/build/action.yml": [
          "name: build", "runs:", "  using: composite", "  steps:", "    - run: nix build .#app", "      shell: bash", "",
        ].join("\n"),
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.path).toBe(WORKFLOW);
    expect(diagnostics[0]?.fix).toBeUndefined();
  });
});

describe("verified quick-install version boundaries are not guessed for future refs", () => {
  it.each([
    ["v24", undefined, 0], ["v25", "2.13", 0], ["v25", "2.13.0", 0], ["v25", "2.13.3", 1],
    ["v35", "2.13.6", 1], ["v35", "2.14.0", 1], ["v35", "2.12.9", 0],
    ["v36", undefined, 0], ["main", undefined, 0], ["0123456789012345678901234567890123456789", undefined, 0],
    ["v35", "${{ inputs.nix }}", 0],
  ] as const)("handles %s with Nix %s", (ref, version, expected) => {
    count(quick, workflow("push", `      - uses: nixbuild/nix-quick-install-action@${ref}`,
      ...(version === undefined ? [] : ["        with:", `          nix_version: '${version}'`]),
      "      - run: nix build .#app"), expected);
  });

  it("distinguishes overwritten installer input from an effective environment override", () => {
    count(quick, workflow("push", "      - uses: nixbuild/nix-quick-install-action@v35", "        with:",
      "          nix_conf: accept-flake-config = false", "      - run: nix build .#app"), 1);
    count(quick, workflow("push", "      - uses: nixbuild/nix-quick-install-action@v35",
      "      - run: nix build .#app", "        env:", "          NIX_CONFIG: accept-flake-config = false"), 0);
  });
});

describe("Nix expression recognition does not promote arbitrary properties to builtins", () => {
  it.each([
    '{ fetchGit = args: args; src = fetchGit { url = "https://example.com/repo"; }; }',
    'let builtins = { fetchGit = args: args; }; in builtins.fetchGit { url = "https://example.com/repo"; }',
    'fetchGit { url = "https://example.com/repo"; }',
    'builtins.fetchGit { url = "https://example.com/repo"; narHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; }',
  ])("does not flag shadowed, unresolved, or content-constrained fetches", (content) => {
    expect(runRule(fetchGit, { files: { "default.nix": content } })).toEqual([]);
  });

  it("recognizes an explicitly inherited builtin", () => {
    expect(runRule(fetchGit, { files: { "default.nix": 'let inherit (builtins) fetchGit; in fetchGit { url = "https://example.com/repo"; }' } })).toHaveLength(1);
  });

  it("does not infer a derivation property from unrelated data", () => {
    expect(runRule(sandbox, { files: { "data.nix": "{ example.__noChroot = true; }" } })).toEqual([]);
  });
});
