import rule from "../../../../src/lint/rules/containers/curl-pipe-shell.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  setup:", "    runs-on: ubuntu-24.04", "    steps:", ...steps.map((line) => `      ${line}`));

ruleTester(rule, {
  valid: [
    ...[
      "curl --help | sh",
      "curl -fsSLV https://example.com/install.sh | bash",
      "wget -VqO- https://example.com/install.sh | sh",
      "curl --config curlrc https://example.com/install.sh | sh",
      "curl -fsSL https://example.com/install.sh > install.sh | sh",
      "curl -fsSL https://example.com/install.sh | sudo -nv bash",
      "curl -fsSL https://example.com/install.sh | command -v bash",
      "curl -fsSL https://example.com/install.sh | bash --help",
      "curl -fsSL https://example.com/install.sh | bash -sn",
      "curl -fsSL https://example.com/install.sh | bash -o noexec",
      "bash -n <(curl -fsSL https://example.com/install.sh)",
      "sudo -nv bash <(curl -fsSL https://example.com/install.sh)",
      "bash <(curl -fsSLo install.sh https://example.com/install.sh)",
      "bash <(curl -fsSL https://example.com/install.sh | sha256sum)",
      'bash -nc "$(curl -fsSL https://example.com/install.sh)"',
      'bash -c "$(curl -fsSLo install.sh https://example.com/install.sh)"',
    ].map((command) => ({ name: `does not assert execution for ${command}`, files: job(`- run: ${command}`) })),
    {
      name: "download to a file, verify the checksum, then execute",
      files: job(
        "- run: |",
        "    curl -fsSLo install.sh https://get.example.com/install.sh",
        '    echo "0123abcd  install.sh" | sha256sum -c -',
        "    sh install.sh",
      ),
    },
    {
      name: "archives piped to tar and JSON piped to jq are not executed",
      files: job(
        "- run: curl -fsSL https://example.com/tool.tar.gz | tar -xz -C /usr/local/bin",
        "- run: curl -fsSL https://api.github.com/repos/o/r/releases/latest | jq -r .tag_name",
      ),
    },
    {
      name: "interpreter given a script file or -c reads data, not code, from stdin",
      files: job(
        "- run: curl -fsSL https://example.com/data.json | python3 scripts/parse.py",
        "- run: curl -fsSL https://example.com/data.txt | sh -c 'cat > data.txt'",
      ),
    },
    {
      name: "pipes inside quotes and comments",
      files: job("- run: |", "    # curl -fsSL https://example.com/install.sh | sh", "    echo 'curl -fsSL https://example.com/install.sh | sh'"),
    },
    {
      name: "curl -o and wget without -O- write to files",
      files: job(
        "- run: curl -fsSL -o install.sh https://example.com/install.sh | sh",
        "- run: curl -fsSLO https://example.com/install.sh | sh",
        "- run: wget -q https://example.com/install.sh && sh install.sh",
      ),
    },
    {
      name: "Dockerfile download verified before running",
      files: {
        Dockerfile: [
          "FROM debian:12-slim",
          "RUN curl -fsSLO https://example.com/install.sh \\",
          '    && echo "0123abcd  install.sh" | sha256sum -c - \\',
          "    && sh install.sh",
          "",
        ].join("\n"),
      },
    },
  ],
  invalid: [
    {
      name: "a checksum after streaming cannot authenticate the already executed payload",
      files: job("- run: |", "    curl -fsSL https://example.com/install.sh | sh", "    sha256sum -c SHA256SUMS"),
      errors: [{ line: 7, messageIncludes: "without verifying a checksum or signature" }],
      output: null,
    },
    {
      name: "a checksum mention in a comment cannot authenticate the streamed payload",
      files: job("- run: |", "    # verified with sha256sum", "    curl -fsSL https://example.com/install.sh | sh"),
      errors: [{ line: 8, messageIncludes: "without verifying a checksum or signature" }],
      output: null,
    },
    {
      name: "quoted output option values retain their lexical boundaries",
      files: job('- run: curl -fsSL -o "-" https://example.com/install.sh | command -p bash -s -- --yes'),
      errors: [{ line: 6, messageIncludes: "with `bash`" }],
      output: null,
    },
    {
      name: "verifying a different file does not verify a later streamed payload",
      files: job(
        "- run: |",
        "    curl -fsSLo key.asc https://example.com/key.asc && gpg --verify install.sh.sig install.sh",
        "    curl -fsSL https://example.com/install.sh | sh",
      ),
      errors: [{ line: 8, messageIncludes: "https://example.com/install.sh" }],
      output: null,
    },
    {
      name: "curl piped to bash in a workflow",
      files: job("- run: curl -fsSL https://get.example.com/install.sh | bash"),
      errors: [
        {
          line: 6,
          messageIncludes:
            "`curl -fsSL https://get.example.com/install.sh | bash` executes a script downloaded from `https://get.example.com/install.sh` with `bash` without verifying a checksum or signature",
        },
      ],
    },
    {
      name: "plain HTTP wget piped through sudo inside a multi-line script",
      files: job("- run: |", "    echo installing", "    wget -qO- http://example.com/setup.sh | sudo -E bash -"),
      errors: [{ line: 8, messageIncludes: "downloaded over plain HTTP from `http://example.com/setup.sh` with `bash`" }],
    },
    {
      name: "process and command substitution",
      files: job(
        "- run: bash <(curl -fsSL https://example.com/a.sh)",
        '- run: sh -c "$(curl -fsSL https://raw.githubusercontent.com/o/r/HEAD/tools/install.sh)"',
      ),
      errors: [
        { line: 6, messageIncludes: "downloaded from `https://example.com/a.sh` with `bash`" },
        { line: 7, messageIncludes: "with `sh` without verifying" },
      ],
    },
    {
      name: "Dockerfile RUN with mount flags and a continuation",
      files: {
        Dockerfile: [
          "FROM debian:12-slim",
          "RUN --mount=type=cache,target=/root/.cache curl -fsSL https://sh.rustup.rs | sh -s -- -y",
          "RUN apt-get update && \\",
          "    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
          "",
        ].join("\n"),
      },
      errors: [
        { path: "Dockerfile", line: 2, messageIncludes: "from `https://sh.rustup.rs` with `sh`" },
        { path: "Dockerfile", line: 4, messageIncludes: "the build bakes whatever the server returns into the image" },
      ],
    },
  ],
});
