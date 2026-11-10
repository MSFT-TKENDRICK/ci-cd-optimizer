import { describe, expect, it } from "vitest";
import { buildProject } from "../../../../src/lint/project.js";
import {
  bypassesRegistry,
  cliConf,
  commandTokens,
  envValue,
  excludesUntrustedPr,
  flakeConfigTrust,
  floatingFlakeRef,
  floatingNixSource,
  hasOption,
  isGitHubHosted,
  nestedInvocations,
  nixCommandSites,
  nixInvocation,
  nixJobs,
  nixPathEntry,
  nixpkgsSearchPath,
  optionArgs,
  optionArity,
  positionalArgs,
  runnerLabels,
  shellConfWrites,
  shellTokens,
  shellWords,
  untrustedPrTrigger,
  usesGlobalRegistry,
} from "../../../../src/lint/rules/nix/shared.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

function project(content: string, extra: Record<string, string> = {}) {
  return buildProject({
    files: [{ path: ".github/workflows/ci.yml", content }, ...Object.entries(extra).map(([path, text]) => ({ path, content: text }))],
    mode: "repository",
    inventoryComplete: true,
  });
}

function firstJob(content: string) {
  const job = project(content).workflows[0]?.jobs[0];
  if (!job) throw new Error("no job");
  return job;
}

describe("shellTokens", () => {
  it("honours single and double quotes and keeps raw text", () => {
    const tokens = shellTokens(`nix --option substituters "https://a https://b" 'x y'`);
    expect(tokens.map((token) => token.value)).toEqual(["nix", "--option", "substituters", "https://a https://b", "x y"]);
    expect(tokens[3]?.raw).toBe(`"https://a https://b"`);
  });

  it("stops at pipes, redirections and comments and drops fd numbers", () => {
    expect(shellTokens("nix build .#a 2>&1 | tee log").map((token) => token.value)).toEqual(["nix", "build", ".#a"]);
    expect(shellTokens("nix build .#a > out").map((token) => token.value)).toEqual(["nix", "build", ".#a"]);
    expect(shellTokens("nix build .#a # comment").map((token) => token.value)).toEqual(["nix", "build", ".#a"]);
  });

  it("keeps a # inside a word and ${{ }} expressions opaque", () => {
    expect(shellTokens("nix build .#default").map((token) => token.value)).toEqual(["nix", "build", ".#default"]);
    expect(shellTokens("nix build .#${{ matrix.pkg | x }}").map((token) => token.value)).toEqual(["nix", "build", ".#${{ matrix.pkg | x }}"]);
  });

  it("handles escapes and unbalanced quotes", () => {
    expect(shellTokens(`echo "a \\"b\\"" c\\ d`).map((token) => token.value)).toEqual(["echo", 'a "b"', "c d"]);
    expect(shellTokens(`nix develop -c bash -c "make`)).toEqual([]);
  });
});

describe("commandTokens / shellWords", () => {
  it("strips assignments and prefix commands with their options", () => {
    expect(shellWords("FOO=1 sudo -E -u root env -i nix build")).toEqual(["nix", "build"]);
    expect(shellWords("time nice -n 5 nix-build")).toEqual(["nix-build"]);
    expect(commandTokens("echo hi").map((token) => token.value)).toEqual(["echo", "hi"]);
  });
});

describe("nixInvocation", () => {
  it("returns undefined for non-Nix commands", () => {
    expect(nixInvocation("echo nix build", 1)).toBeUndefined();
    expect(nixInvocation("nixfmt .", 1)).toBeUndefined();
  });

  it("finds grouped subcommands past global options with values", () => {
    const invocation = nixInvocation("nix --option sandbox false --extra-experimental-features 'nix-command flakes' flake check -L", 3);
    expect(invocation).toMatchObject({ binary: "nix", subcommand: "flake check", line: 3 });
    expect(invocation?.args).toEqual(["--option", "sandbox", "false", "--extra-experimental-features", "nix-command flakes", "-L"]);
  });

  it("resolves the binary through absolute paths and sudo", () => {
    expect(nixInvocation("sudo /nix/var/nix/profiles/default/bin/nix-env -iA nixpkgs.jq", 1)).toMatchObject({
      binary: "nix-env",
      subcommand: "",
      args: ["-iA", "nixpkgs.jq"],
    });
  });

  it("captures the wrapped command of nix develop -c", () => {
    const develop = nixInvocation("nix develop .#ci --command cargo test --all", 1);
    expect(develop).toMatchObject({ subcommand: "develop", args: [".#ci"], inner: "cargo test --all" });
    expect(nixInvocation(`nix develop -c bash -c "make check"`, 1)?.inner).toBe(`bash -c "make check"`);
    expect(nixInvocation(`nix develop -c 'make check'`, 1)?.inner).toBe("make check");
  });

  it("captures exactly one --run argument for nix-shell", () => {
    const shell = nixInvocation(`nix-shell --run "make test" -p jq shell.nix`, 1);
    expect(shell).toMatchObject({ binary: "nix-shell", inner: "make test", args: ["-p", "jq", "shell.nix"] });
  });

  it("ignores words after a pipe", () => {
    expect(nixInvocation("nix build .#a --impure-not | grep --impure", 1)?.args).toEqual([".#a", "--impure-not"]);
  });
});

describe("cliConf", () => {
  const conf = (command: string) =>
    cliConf(nixInvocation(command, 7) ?? { binary: "", subcommand: "", args: [], command, line: 7 }, "ci.yml").map(
      (setting) => `${setting.key}=${setting.value}`,
    );

  it("reads --option and --extra-option", () => {
    expect(conf("nix build --option sandbox false --extra-option substituters https://x")).toEqual([
      "sandbox=false",
      "extra-substituters=https://x",
    ]);
  });

  it("reads setting flags in both spellings", () => {
    expect(conf("nix build -j 2 --cores=4 --max-jobs=3 -j8 --extra-substituters https://c")).toEqual([
      "max-jobs=2",
      "cores=4",
      "max-jobs=3",
      "max-jobs=8",
      "extra-substituters=https://c",
    ]);
  });

  it("reads boolean flags", () => {
    expect(conf("nix build --no-sandbox --accept-flake-config")).toEqual(["sandbox=false", "accept-flake-config=true"]);
    expect(conf("nix-build --relaxed-sandbox --no-accept-flake-config")).toEqual(["sandbox=relaxed", "accept-flake-config=false"]);
  });

  it("reads --builders", () => {
    expect(conf("nix build --builders 'ssh://b x86_64-linux' -j 0 .#a")).toEqual(["builders=ssh://b x86_64-linux", "max-jobs=0"]);
  });

  it("reports settings at the invocation line with source cli", () => {
    const invocation = nixInvocation("nix build -j auto", 9);
    expect(invocation && cliConf(invocation, "x.yml")).toEqual([{ key: "max-jobs", value: "auto", line: 9, path: "x.yml", source: "cli" }]);
  });
});

describe("shellConfWrites", () => {
  it("reads echo/printf appends to nix.conf", () => {
    expect(shellConfWrites(`echo "sandbox = false" | sudo tee -a /etc/nix/nix.conf`, "ci.yml", 4)).toEqual([
      { key: "sandbox", value: "false", line: 4, path: "ci.yml", source: "shell" },
    ]);
    expect(shellConfWrites(`printf 'max-jobs = 2\\ncores = 0\\n' >> ~/.config/nix/nix.conf`, "ci.yml", 5).map((setting) => setting.key)).toEqual([
      "max-jobs",
      "cores",
    ]);
    expect(shellConfWrites(`echo -e "accept-flake-config = true" >> /etc/nix/nix.conf`, "ci.yml", 6)).toEqual([]);
  });

  it("ignores commands that do not write nix.conf", () => {
    expect(shellConfWrites(`echo "sandbox = false"`, "ci.yml", 1)).toEqual([]);
    expect(shellConfWrites(`cat /etc/nix/nix.conf`, "ci.yml", 1)).toEqual([]);
    expect(shellConfWrites(`grep sandbox /etc/nix/nix.conf > out.txt`, "ci.yml", 1)).toEqual([]);
    expect(shellConfWrites(`echo "sandbox = false # >> /etc/nix/nix.conf"`, "ci.yml", 1)).toEqual([]);
    expect(shellConfWrites(`echo "sandbox = false" >> ./examples/nix.conf`, "ci.yml", 1)).toEqual([]);
  });
});

describe("isGitHubHosted", () => {
  const hosted = (runsOn: string, ...extra: string[]) =>
    isGitHubHosted(firstJob(yml("on: push", "jobs:", "  build:", `    runs-on: ${runsOn}`, ...extra, "    steps:", "      - run: true")));

  it("accepts standard images", () => {
    expect(hosted("ubuntu-24.04")).toBe(true);
    expect(hosted("macos-latest")).toBe(true);
    expect(hosted("[ubuntu-latest]")).toBe(true);
  });

  it("rejects self-hosted and custom labels", () => {
    expect(hosted("self-hosted")).toBe(false);
    expect(hosted("[self-hosted, linux]")).toBe(false);
    expect(hosted("nixos-builder")).toBe(false);
  });

  it("resolves matrix values", () => {
    const matrix = ["    strategy:", "      matrix:", "        os: [ubuntu-latest, macos-14]"];
    expect(hosted("${{ matrix.os }}", ...matrix)).toBe(true);
    const mixed = ["    strategy:", "      matrix:", "        os: [ubuntu-latest]", "        include:", "          - os: self-hosted"];
    expect(hosted("${{ matrix.os }}", ...mixed)).toBe(false);
    expect(hosted("${{ matrix.runner }}", ...matrix)).toBe(false);
    expect(hosted("${{ inputs.runner }}")).toBe(false);
  });
});

describe("nixJob conf", () => {
  it("collects installer, env, step env, CLI and shell-written settings", () => {
    const content = yml(
      "on: push",
      "env:",
      "  NIX_CONFIG: max-jobs = 4",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: cachix/install-nix-action@v31",
      "        with:",
      "          extra_nix_config: |",
      "            sandbox = relaxed",
      "      - run: echo 'cores = 2' | sudo tee -a /etc/nix/nix.conf",
      "      - run: nix build --accept-flake-config .#a",
      "        env:",
      "          NIX_CONFIG: substituters = https://x",
    );
    const [job] = [...nixJobs(project(content))];
    expect(job?.conf.map((setting) => [setting.key, setting.value, setting.source, setting.line])).toEqual([
      ["max-jobs", "4", "env", 1],
      ["sandbox", "relaxed", "installer", 11],
      ["substituters", "https://x", "env", 13],
      ["cores", "2", "shell", 12],
      ["accept-flake-config", "true", "cli", 13],
    ]);
  });
});

describe("nixCommandSites", () => {
  it("dedupes composite-action commands used by several jobs and includes unused actions", () => {
    const action = yml("name: setup", "runs:", "  using: composite", "  steps:", "    - run: nix build .#a", "      shell: bash");
    const unused = yml("name: other", "runs:", "  using: composite", "  steps:", "    - run: nix-env -iA nixpkgs.hello", "      shell: bash");
    const content = yml(
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/setup",
      "  b:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/setup",
      "      - run: nix flake check",
    );
    const sites = [
      ...nixCommandSites(project(content, { ".github/actions/setup/action.yml": action, ".github/actions/other/action.yml": unused })),
    ];
    expect(sites.map((site) => [site.path, site.line, site.nix.subcommand, site.job?.job.id])).toEqual([
      [".github/actions/setup/action.yml", 5, "build", "a"],
      [".github/workflows/ci.yml", 11, "flake check", "b"],
      [".github/actions/other/action.yml", 5, "", undefined],
    ]);
  });
});

describe("envValue", () => {
  it("prefers step over job over workflow env", () => {
    const content = yml(
      "on: push",
      "env: { A: wf, B: wf, C: wf }",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    env: { A: job, B: job }",
      "    steps:",
      "      - run: true",
      "        env: { A: step }",
    );
    const model = project(content);
    const workflow = model.workflows[0];
    const job = workflow?.jobs[0];
    if (!workflow || !job) throw new Error("no job");
    expect(["A", "B", "C", "D"].map((name) => envValue(workflow, job, job.steps[0], name))).toEqual(["step", "job", "wf", undefined]);
  });
});

describe("untrustedPrTrigger", () => {
  const trigger = (on: string, ...steps: string[]) => {
    const model = project(yml(`on: ${on}`, "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps));
    const workflow = model.workflows[0];
    const job = workflow?.jobs[0];
    if (!workflow || !job) throw new Error("no job");
    return untrustedPrTrigger(model, workflow, job);
  };

  it("reports pull_request and head checkouts under pull_request_target", () => {
    expect(trigger("pull_request", "      - run: true")).toBe("pull_request");
    expect(trigger("pull_request_target", "      - uses: actions/checkout@v4", "        with:", "          ref: ${{ github.event.pull_request.head.sha }}")).toBe(
      "pull_request_target",
    );
    expect(trigger("pull_request_target", "      - run: gh pr checkout ${{ github.event.number }}")).toBe("pull_request_target");
    expect(trigger("pull_request_target", "      - run: git fetch origin refs/pull/1/head")).toBe("pull_request_target");
  });

  it("ignores base-branch pull_request_target, merge_group and push", () => {
    expect(trigger("pull_request_target", "      - uses: actions/checkout@v4")).toBeUndefined();
    expect(trigger("merge_group", "      - run: true")).toBeUndefined();
    expect(trigger("push", "      - run: true")).toBeUndefined();
  });
});

describe("excludesUntrustedPr", () => {
  const excluded = (condition: string, trigger = "pull_request") =>
    excludesUntrustedPr(firstJob(yml("on: pull_request", "jobs:", "  build:", "    runs-on: ubuntu-latest", `    if: ${condition}`, "    steps:", "      - run: true")), trigger);

  it("accepts fork guards and event-name exclusions", () => {
    expect(excluded("github.event.pull_request.head.repo.full_name == github.repository")).toBe(true);
    expect(excluded("${{ !github.event.pull_request.head.repo.fork }}")).toBe(true);
    expect(excluded("github.event.pull_request.head.repo.fork == false")).toBe(true);
    expect(excluded("github.event_name != 'pull_request'")).toBe(true);
    expect(excluded("github.event_name == 'push'")).toBe(true);
  });

  it("rejects disjunctions and conditions that still admit the trigger", () => {
    expect(excluded("github.event_name == 'push' || github.event_name == 'pull_request'")).toBe(false);
    expect(excluded("github.event_name != 'pull_request' || always()")).toBe(false);
    expect(excluded("github.event_name == 'pull_request'")).toBe(false);
    expect(excluded("success()")).toBe(false);
  });
});

describe("flakeConfigTrust", () => {
  const trust = (...lines: string[]) => {
    const [job] = [...nixJobs(project(yml(...lines)))];
    if (!job) throw new Error("no nix job");
    return flakeConfigTrust(job).map((entry) => [entry.via, entry.line]);
  };
  const header = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:"];

  it("finds installer, env and CLI trust", () => {
    expect(
      trust(...header, "      - uses: cachix/install-nix-action@v31", "        with:", "          extra_nix_config: accept-flake-config = true", "      - run: nix build"),
    ).toEqual([["installer", 8]]);
    expect(trust(...header, "      - uses: cachix/install-nix-action@v31", "      - run: nix build --accept-flake-config")).toEqual([["cli", 7]]);
    expect(trust(...header, "      - uses: cachix/install-nix-action@v31", "      - run: nix build", "        env:", "          NIX_CONFIG: accept-flake-config = true")).toEqual([
      ["env", 7],
    ]);
  });

  it("treats nix-quick-install-action as implicit trust unless overridden", () => {
    expect(trust(...header, "      - uses: nixbuild/nix-quick-install-action@v35", "      - run: nix build")).toEqual([["implicit", 6]]);
    expect(
      trust(...header, "      - uses: nixbuild/nix-quick-install-action@v35", "        with:", "          nix_version: 2.13.3", "      - run: nix build"),
    ).toEqual([["implicit", 6]]);
    expect(trust(...header, "      - uses: nixbuild/nix-quick-install-action@v35", "      - run: nix build --no-accept-flake-config")).toEqual([]);
    expect(
      trust(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      NIX_CONFIG: accept-flake-config = false",
        "    steps:",
        "      - uses: nixbuild/nix-quick-install-action@v35",
        "      - run: nix build",
      ),
    ).toEqual([]);
  });

  it("uses inspected release families and never infers moving-ref behavior", () => {
    const step = (uses: string) => trust(...header, `      - uses: ${uses}`, "      - run: nix build");
    expect(step("nixbuild/nix-quick-install-action@v24")).toEqual([]);
    expect(step("nixbuild/nix-quick-install-action@v25")).toEqual([["implicit", 6]]);
    expect(step("nixbuild/nix-quick-install-action@master")).toEqual([]);
    expect(step("nixbuild/nix-quick-install-action@5bb6a3b3abe66fd09bbf250dce8ada94f856a703 # v30")).toEqual([["implicit", 6]]);
    expect(step("nixbuild/nix-quick-install-action@5bb6a3b3abe66fd09bbf250dce8ada94f856a703 # v22")).toEqual([]);
    expect(step("nixbuild/nix-quick-install-action@5bb6a3b3abe66fd09bbf250dce8ada94f856a703")).toEqual([]);
  });

  it("ignores classic commands and jobs that never run a flake command", () => {
    expect(trust(...header, "      - uses: nixbuild/nix-quick-install-action@v35", "      - run: nix-build default.nix")).toEqual([]);
    expect(
      trust(...header, "      - uses: cachix/install-nix-action@v31", "        with:", "          extra_nix_config: accept-flake-config = true", "      - run: nix-shell --run make"),
    ).toEqual([]);
  });

  it("counts a nix develop custom shell as a flake command", () => {
    expect(
      trust(
        "on: push",
        "defaults:",
        "  run:",
        "    shell: nix develop --command bash -e {0}",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: nixbuild/nix-quick-install-action@v35",
        "      - run: make",
      ),
    ).toEqual([["implicit", 9]]);
  });
});

describe("positionalArgs", () => {
  const positional = (command: string): string[] => {
    const invocation = nixInvocation(command, 1);
    if (!invocation) throw new Error("not nix");
    return positionalArgs(invocation);
  };

  it("skips options and the values they consume", () => {
    expect(positional("nix build --override-input nixpkgs github:a/b .#a -o out .#b")).toEqual([".#a", ".#b"]);
    expect(positional("nix build -L --option sandbox false .#x --max-jobs 4")).toEqual([".#x"]);
    expect(positional("nix build --out-link=result .#y")).toEqual([".#y"]);
  });

  it("stops at -- and treats new-CLI --expr/-f as value-taking", () => {
    expect(positional("nix run nixpkgs#hello -- --greeting hi")).toEqual(["nixpkgs#hello"]);
    expect(positional("nix build -f default.nix hello")).toEqual(["hello"]);
    expect(positional("nix build --expr 'import ./x.nix'")).toEqual([]);
  });

  it("treats --flake as value-taking (nix flake update input names)", () => {
    expect(positional("nix flake update --flake ./sub nixpkgs home-manager")).toEqual(["nixpkgs", "home-manager"]);
  });

  it("returns package names for classic tools", () => {
    expect(positional("nix-shell -I nixpkgs=channel:nixos-24.05 -p jq curl")).toEqual(["jq", "curl"]);
    expect(positional("nix-build -A hello default.nix")).toEqual(["default.nix"]);
  });
});

describe("optionArity", () => {
  const arity = (command: string, word: string): number => {
    const invocation = nixInvocation(command, 1);
    if (!invocation) throw new Error("not nix");
    return optionArity(invocation, word);
  };

  it("counts the values each option consumes", () => {
    expect(arity("nix build .#a", "--override-input")).toBe(2);
    expect(arity("nix build .#a", "-o")).toBe(1);
    expect(arity("nix build .#a", "-L")).toBe(0);
    expect(arity("nix build .#a", "--unknown-flag")).toBe(0);
  });

  it("treats --expr and -f as value-taking only for the new CLI", () => {
    expect(arity("nix build --expr x", "--expr")).toBe(1);
    expect(arity("nix build -f default.nix", "-f")).toBe(1);
  });
});

describe("nestedInvocations", () => {
  it("follows nix develop -c into the wrapped nix command", () => {
    const invocation = nixInvocation("nix develop .#ci -c nix flake check --no-build", 3);
    if (!invocation) throw new Error("not nix");
    const chain = nestedInvocations(invocation);
    expect(chain.map((item) => item.subcommand)).toEqual(["develop", "flake check"]);
    expect(chain[1]?.args).toEqual(["--no-build"]);
    expect(chain[1]?.line).toBe(3);
  });

  it("follows nix-shell --run and stops at non-nix programs", () => {
    const shell = nixInvocation(`nix-shell --run "nix-build -A x"`, 1);
    if (!shell) throw new Error("not nix");
    expect(nestedInvocations(shell).map((item) => item.binary)).toEqual(["nix-shell", "nix-build"]);
    const wrapped = nixInvocation(`nix develop -c bash -c "nix build .#a"`, 1);
    if (!wrapped) throw new Error("not nix");
    expect(nestedInvocations(wrapped)).toHaveLength(1);
  });
});

describe("runnerLabels", () => {
  it("resolves matrix runner labels, including include entries", () => {
    const job = firstJob(
      yml(
        "on: push",
        "jobs:",
        "  build:",
        "    strategy:",
        "      matrix:",
        "        os: [ubuntu-24.04, macos-14]",
        "        include:",
        "          - os: ubuntu-24.04-arm",
        "    runs-on: ${{ matrix.os }}",
        "    steps:",
        "      - run: true",
      ),
    );
    expect(runnerLabels(job)).toEqual(["ubuntu-24.04", "macos-14", "ubuntu-24.04-arm"]);
  });

  it("keeps unresolvable expressions and plain labels as written", () => {
    expect(runnerLabels(firstJob(yml("on: push", "jobs:", "  a:", "    runs-on: [self-hosted, nix]", "    steps:", "      - run: true")))).toEqual([
      "self-hosted",
      "nix",
    ]);
    expect(runnerLabels(firstJob(yml("on: push", "jobs:", "  a:", "    runs-on: ${{ inputs.runner }}", "    steps:", "      - run: true")))).toEqual([
      "${{ inputs.runner }}",
    ]);
  });
});

describe("floatingFlakeRef", () => {
  it("flags the registry entry and moving nixpkgs branches", () => {
    expect(floatingFlakeRef("nixpkgs#hello")).toMatchObject({ indirect: true, reason: expect.stringContaining("registry") as string });
    expect(floatingFlakeRef("flake:nixpkgs")).toMatchObject({ indirect: true });
    expect(floatingFlakeRef("nixpkgs/nixos-24.11#jq")).toMatchObject({ indirect: true, reason: expect.stringContaining("nixos-24.11") as string });
    expect(floatingFlakeRef("github:NixOS/nixpkgs/nixos-unstable#jq")).toMatchObject({ indirect: false });
    expect(floatingFlakeRef("github:nixos/nixpkgs#jq")).toMatchObject({ reason: expect.stringContaining("default branch") as string });
    expect(floatingFlakeRef("github:NixOS/nixpkgs?ref=nixpkgs-unstable#jq")).toMatchObject({ indirect: false });
    expect(floatingFlakeRef("https://github.com/NixOS/nixpkgs/archive/master.tar.gz")).toMatchObject({ indirect: false });
  });

  it("accepts commits, rev/narHash pins, tags, other flakes and dynamic refs", () => {
    expect(floatingFlakeRef("github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567#jq")).toBeUndefined();
    expect(floatingFlakeRef("nixpkgs/0123456789abcdef0123456789abcdef01234567#jq")).toBeUndefined();
    expect(floatingFlakeRef("github:NixOS/nixpkgs?rev=0123456789abcdef0123456789abcdef01234567#jq")).toBeUndefined();
    expect(floatingFlakeRef("github:NixOS/nixpkgs/24.05#jq")).toBeUndefined();
    expect(floatingFlakeRef(".#jq")).toBeUndefined();
    expect(floatingFlakeRef("github:numtide/flake-utils")).toBeUndefined();
    expect(floatingFlakeRef("nixpkgs-fmt")).toBeUndefined();
    expect(floatingFlakeRef("github:NixOS/nixpkgs/${REV}#jq")).toBeUndefined();
  });
});

describe("floatingNixSource", () => {
  it("flags channels, channel URLs, branch tarballs and floating flake refs", () => {
    expect(floatingNixSource("channel:nixos-unstable")?.reason).toContain("nixos-unstable channel");
    expect(floatingNixSource("https://nixos.org/channels/nixpkgs-unstable")?.reason).toContain("nixpkgs-unstable channel");
    expect(floatingNixSource("https://channels.nixos.org/nixos-24.11/nixexprs.tar.xz")?.reason).toContain("nixos-24.11");
    expect(floatingNixSource("https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz")?.reason).toContain("nixos-unstable branch");
    expect(floatingNixSource("https://github.com/NixOS/nixpkgs/tarball/refs/heads/master")?.reason).toContain("master branch");
    expect(floatingNixSource("flake:nixpkgs")).toMatchObject({ indirect: true });
  });

  it("accepts commit tarballs, paths, unknown URLs and dynamic values", () => {
    expect(floatingNixSource("https://github.com/NixOS/nixpkgs/archive/0123456789abcdef0123456789abcdef01234567.tar.gz")).toBeUndefined();
    expect(floatingNixSource("./nix/nixpkgs.nix")).toBeUndefined();
    expect(floatingNixSource("https://example.com/nixpkgs.tar.gz")).toBeUndefined();
    expect(floatingNixSource("$NIXPKGS")).toBeUndefined();
    expect(floatingNixSource("")).toBeUndefined();
  });
});

describe("nixPathEntry", () => {
  it("finds the first named entry in colon- or space-separated search paths", () => {
    expect(nixPathEntry("nixpkgs=channel:nixos-unstable", "nixpkgs")).toBe("channel:nixos-unstable");
    expect(nixPathEntry("foo=/a:nixpkgs=https://github.com/NixOS/nixpkgs/archive/x.tar.gz:/b", "nixpkgs")).toBe(
      "https://github.com/NixOS/nixpkgs/archive/x.tar.gz",
    );
    expect(nixPathEntry("nixpkgs=flake:nixpkgs nixpkgs=/other", "nixpkgs")).toBe("flake:nixpkgs");
    expect(nixPathEntry("/nix/var/nix/profiles/per-user/root/channels", "nixpkgs")).toBeUndefined();
    expect(nixPathEntry("", "nixpkgs")).toBeUndefined();
  });
});

describe("nixpkgsSearchPath", () => {
  const head = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:"];
  const resolve = (content: string, extra: Record<string, string> = {}) => {
    const sites = [...nixCommandSites(project(content, extra))].filter((site) => site.nix.binary === "nix-shell" || site.nix.subcommand !== "");
    const site = sites.find((candidate) => nestedInvocations(candidate.nix).some((nix) => nix.binary === "nix-shell" || nix.binary === "nix-env"));
    if (!site) throw new Error("no classic command");
    const chain = nestedInvocations(site.nix);
    const depth = chain.findIndex((nix) => nix.binary === "nix-shell" || nix.binary === "nix-env");
    return nixpkgsSearchPath(project(content, extra), site, chain, depth);
  };

  it("prefers -I, then a NIX_PATH prefix, then env", () => {
    expect(
      resolve(yml(...head, "      - uses: cachix/install-nix-action@v31", "      - run: nix-shell -I foo=/x -I nixpkgs=channel:nixos-24.11 -p jq")),
    ).toMatchObject({ value: "channel:nixos-24.11", origin: "`-I nixpkgs=`", line: 7 });
    expect(resolve(yml(...head, "      - uses: cachix/install-nix-action@v31", "      - run: NIX_PATH=nixpkgs=channel:nixos-unstable nix-shell -p jq"))).toMatchObject({
      value: "channel:nixos-unstable",
    });
    expect(
      resolve(yml("on: push", "env:", "  NIX_PATH: nixpkgs=channel:nixos-unstable", ...head.slice(1), "      - uses: cachix/install-nix-action@v31", "      - run: nix-shell -p jq")),
    ).toMatchObject({ value: "channel:nixos-unstable", origin: "the workflow's `NIX_PATH`" });
  });

  it("reads install-nix-action's nix_path input and the Determinate default", () => {
    expect(
      resolve(yml(...head, "      - uses: cachix/install-nix-action@v31", "        with:", "          nix_path: nixpkgs=channel:nixos-unstable", "      - run: nix-shell -p jq")),
    ).toMatchObject({ value: "channel:nixos-unstable", line: 8 });
    expect(resolve(yml(...head, "      - uses: DeterminateSystems/nix-installer-action@v21", "      - run: nix-shell -p jq"))).toMatchObject({
      value: "flake:nixpkgs",
      line: 6,
    });
  });

  it("is unknown for bare -I directories, exported NIX_PATH, channels and nix develop wrappers", () => {
    const determinate = [...head, "      - uses: DeterminateSystems/nix-installer-action@v21"];
    expect(resolve(yml(...determinate, "      - run: nix-shell -I ./nix -p jq"))).toBeUndefined();
    expect(resolve(yml(...determinate, "      - run: echo NIX_PATH=nixpkgs=./pin.nix >> $GITHUB_ENV", "      - run: nix-shell -p jq"))).toBeUndefined();
    expect(resolve(yml(...determinate, "      - run: nix-channel --update", "      - run: nix-shell -p jq"))).toBeUndefined();
    expect(resolve(yml(...determinate, "      - run: nix develop -c nix-shell -p jq"))).toBeUndefined();
    expect(resolve(yml(...head, "      - uses: cachix/install-nix-action@v31", "      - run: nix-shell -p jq"))).toBeUndefined();
  });
});

describe("bypassesRegistry and usesGlobalRegistry", () => {
  const sites = (content: string) => [...nixCommandSites(project(content))];

  it("recognises registry overrides and --file installables", () => {
    const check = (command: string): boolean => {
      const nix = nixInvocation(command, 1);
      if (!nix) throw new Error("not nix");
      return bypassesRegistry(nix);
    };
    expect(check("nix shell --inputs-from . nixpkgs#jq")).toBe(true);
    expect(check("nix run --override-flake nixpkgs github:NixOS/nixpkgs/abc nixpkgs#jq")).toBe(true);
    expect(check("nix build -f . hello")).toBe(true);
    expect(check("nix run nixpkgs#jq")).toBe(false);
  });

  it("assumes the global registry only on hosted runners without a registry pin", () => {
    const hosted = sites(yml("on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: nix run nixpkgs#jq"));
    const site = hosted[0];
    if (!site) throw new Error("no site");
    expect(usesGlobalRegistry(project(yml("on: push")), site)).toBe(true);
    const pinnedContent = yml(
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: nix registry pin nixpkgs github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567",
      "      - run: nix run nixpkgs#jq",
    );
    const pinned = sites(pinnedContent).find((entry) => entry.nix.subcommand === "run");
    if (!pinned) throw new Error("no site");
    expect(usesGlobalRegistry(project(pinnedContent), pinned)).toBe(false);
    const selfHosted = sites(yml("on: push", "jobs:", "  a:", "    runs-on: [self-hosted]", "    steps:", "      - run: nix run nixpkgs#jq"))[0];
    if (!selfHosted) throw new Error("no site");
    expect(usesGlobalRegistry(project(yml("on: push")), selfHosted)).toBe(false);
  });
});

describe("optionArgs", () => {
  const inv = (command: string) => {
    const nix = nixInvocation(command, 1);
    if (!nix) throw new Error("not nix");
    return nix;
  };

  it("stops at -- so program arguments are not read as Nix options", () => {
    expect(optionArgs(inv("nix run .#tool -- -j 2 --impure"))).toEqual([".#tool"]);
    expect(cliConf(inv("nix run .#tool -- -j 2 --no-sandbox"), "ci.yml")).toEqual([]);
    expect(hasOption(inv("nix run .#tool -- --impure"), "--impure")).toBe(false);
    expect(optionArgs(inv("nix build --impure .#a -- x"))).toEqual(["--impure", ".#a"]);
  });

  it("continues parsing Nix options after the installable until an explicit separator", () => {
    expect(optionArgs(inv("nix run --max-jobs 2 .#tool --impure"))).toEqual(["--max-jobs", "2", ".#tool", "--impure"]);
    expect(cliConf(inv("nix run --max-jobs 2 .#tool -j 8"), "ci.yml").map((s) => s.value)).toEqual(["2", "8"]);
    expect(optionArgs(inv("nix build .#a --impure"))).toEqual([".#a", "--impure"]);
  });
});
