import rule from "../../../../src/lint/rules/caching/matrix-cache-key-missing-os.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const matrixJob = (oses: string, ...stepLines: string[]): string =>
  yml(
    "on: push",
    "jobs:",
    "  test:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    `        os: [${oses}]`,
    "    steps:",
    "      - uses: actions/checkout@v5",
    ...stepLines,
  );

const cache = (key: string, path = "node_modules", ...extra: string[]): string[] => [
  "      - uses: actions/cache@v6",
  "        with:",
  `          path: ${path}`,
  `          key: ${key}`,
  ...extra,
];

const LOCK = "${{ hashFiles('package-lock.json') }}";

ruleTester(rule, {
  valid: [
    {
      name: "key includes runner.os",
      files: matrixJob("ubuntu-latest, macos-latest", ...cache(`\${{ runner.os }}-modules-${LOCK}`)),
    },
    {
      name: "key includes matrix.os",
      files: matrixJob("ubuntu-latest, macos-latest", ...cache(`modules-\${{ matrix.os }}-${LOCK}`)),
    },
    {
      name: "trap: legs share OS and architecture",
      files: matrixJob("ubuntu-latest, ubuntu-24.04", ...cache(`modules-${LOCK}`)),
    },
    {
      name: "trap: Linux + Windows only (Windows caches get a different version without enableCrossOsArchive)",
      files: matrixJob("ubuntu-latest, windows-latest", ...cache(`modules-${LOCK}`)),
    },
    {
      name: "trap: platform-neutral download cache",
      files: matrixJob("ubuntu-latest, macos-latest", ...cache(`npm-${LOCK}`, "~/.npm")),
    },
    {
      name: "trap: self-hosted labels are not modeled",
      files: matrixJob("linux-builder, mac-builder", ...cache(`modules-${LOCK}`)),
    },
    {
      name: "trap: fixed runner with a version matrix",
      files: yml(
        "on: push",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    strategy:",
        "      matrix:",
        "        node: [20, 22]",
        "    steps:",
        ...cache(`modules-${LOCK}`),
      ),
    },
    {
      name: "trap: key from a step output may already be platform specific",
      files: matrixJob("ubuntu-latest, macos-latest", ...cache("${{ steps.meta.outputs.key }}")),
    },
  ],
  invalid: [
    {
      name: "Linux + macOS share a node_modules cache",
      files: matrixJob("ubuntu-latest, macos-latest", ...cache(`modules-${LOCK}`)),
      errors: [
        {
          line: 13,
          messageIncludes: `Cache key \`modules-${LOCK}\` in matrix job \`test\` resolves to the same key and cache version on \`ubuntu-latest\` (Linux X64) and \`macos-latest\` (macOS ARM64)`,
        },
      ],
      output: matrixJob("ubuntu-latest, macos-latest", ...cache(`\${{ runner.os }}-modules-${LOCK}`)),
    },
    {
      name: "quoted key and block restore-keys are both prefixed",
      files: matrixJob(
        "ubuntu-latest, macos-latest, windows-latest",
        ...cache(`"venv-${LOCK}"`, ".venv", "          restore-keys: |", "            venv-"),
      ),
      errors: [{ line: 13, messageIncludes: "`macos-latest` (macOS ARM64)" }],
      output: matrixJob(
        "ubuntu-latest, macos-latest, windows-latest",
        ...cache(`"\${{ runner.os }}-venv-${LOCK}"`, ".venv", "          restore-keys: |", "            ${{ runner.os }}-venv-"),
      ),
    },
    {
      name: "x64 and arm64 Linux legs need runner.arch",
      files: matrixJob("ubuntu-24.04, ubuntu-24.04-arm", ...cache(`target-${LOCK}`, "target")),
      errors: [{ line: 13, messageIncludes: "`ubuntu-24.04` (Linux X64) and `ubuntu-24.04-arm` (Linux ARM64)" }],
      output: matrixJob("ubuntu-24.04, ubuntu-24.04-arm", ...cache(`\${{ runner.arch }}-target-${LOCK}`, "target")),
    },
    {
      name: "restore/save pair: the restore key is reported and fixed",
      files: matrixJob(
        "ubuntu-latest, macos-latest",
        "      - id: restore",
        "        uses: actions/cache/restore@v6",
        "        with:",
        "          path: build",
        `          key: build-${LOCK}`,
        "      - run: make",
        "      - uses: actions/cache/save@v6",
        "        with:",
        "          path: build",
        "          key: ${{ steps.restore.outputs.cache-primary-key }}",
      ),
      errors: [{ line: 14, messageIncludes: `Cache key \`build-${LOCK}\`` }],
      output: matrixJob(
        "ubuntu-latest, macos-latest",
        "      - id: restore",
        "        uses: actions/cache/restore@v6",
        "        with:",
        "          path: build",
        `          key: \${{ runner.os }}-build-${LOCK}`,
        "      - run: make",
        "      - uses: actions/cache/save@v6",
        "        with:",
        "          path: build",
        "          key: ${{ steps.restore.outputs.cache-primary-key }}",
      ),
    },
  ],
});
