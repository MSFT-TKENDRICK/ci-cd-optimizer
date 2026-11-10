import rule from "../../../../src/lint/rules/workflow/setup-action-missing-version-file.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const WORKFLOW = ".github/workflows/ci.yml";

const steps = (...stepLines: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

const CHECKOUT = "      - uses: actions/checkout@v5";

ruleTester(rule, {
  valid: [
    {
      name: "setup-node with an inline version",
      files: steps(CHECKOUT, "      - uses: actions/setup-node@v6", "        with:", "          node-version: 22"),
    },
    {
      name: "setup-node with a version file",
      files: steps(CHECKOUT, "      - uses: actions/setup-node@v6", "        with:", "          node-version-file: .nvmrc"),
    },
    {
      name: "setup-go with a matrix expression",
      files: steps(CHECKOUT, "      - uses: actions/setup-go@v6", "        with:", "          go-version: ${{ matrix.go }}"),
    },
    {
      name: "trap: setup-python reads a root .python-version on its own",
      files: { [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-python@v6"), ".python-version": "3.13\n" },
    },
    {
      name: "trap: setup-dotnet reads a root global.json on its own",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-dotnet@v5"),
        "global.json": JSON.stringify({ sdk: { version: "9.0.100" } }),
      },
    },
    {
      name: "trap: without the full file inventory a root .python-version may exist",
      files: steps(CHECKOUT, "      - uses: actions/setup-python@v6"),
      inventoryComplete: false,
    },
    {
      name: "trap: setup-java fails without a version, so it is not this rule's concern",
      files: steps(CHECKOUT, "      - uses: actions/setup-java@v5", "        with:", "          distribution: temurin"),
    },
    ...["v7", "main", "0123456789abcdef0123456789abcdef01234567"].map((version) => ({
      name: `unknown setup-node version semantics are not guessed: ${version}`,
      files: { [WORKFLOW]: steps(CHECKOUT, `      - uses: actions/setup-node@${version}`), ".nvmrc": "22\n" },
    })),
  ],
  invalid: [
    {
      name: "bare setup-node with .nvmrc gets an advisory version-file recommendation",
      files: { [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-node@v6", "      - run: npm ci"), ".nvmrc": "22\n" },
      errors: [
        {
          line: 7,
          messageIncludes:
            "`actions/setup-node` sets neither `node-version` nor `node-version-file`, so the Node.js version already on the runner's PATH is used; runner image or provisioning changes can change that version. The repository declares Node.js in `.nvmrc`.",
        },
      ],
      output: null,
    },
    {
      name: "existing with block is left unchanged while recommending the version file",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - name: Node", "        uses: actions/setup-node@v6", "        with:", "          cache: npm"),
        ".node-version": "v22.11.0\n",
      },
      errors: [{ line: 8, messageIncludes: "`actions/setup-node` sets neither `node-version` nor `node-version-file`, so the Node.js version already on the runner's PATH is used; runner image or provisioning changes can change that version. The repository declares Node.js in `.node-version`." }],
      output: null,
    },
    {
      name: "setup-go reads go.mod",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-go@v6", "        with:", "          cache: false"),
        "go.mod": "module example.com/app\n\ngo 1.24.0\n",
      },
      errors: [{ line: 7, messageIncludes: "so the action uses the Go version pre-installed on the runner" }],
      output: null,
    },
    {
      name: "setup-dotnet with a single nested global.json",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-dotnet@v5"),
        "src/global.json": JSON.stringify({ sdk: { version: "9.0.100" } }),
      },
      errors: [{ line: 7, messageIncludes: "`actions/setup-dotnet` sets neither `dotnet-version` nor `global-json-file`, so without a root `global.json` no SDK is installed and the newest SDK pre-installed on the runner is used; runner image or provisioning changes can change that version. The repository declares .NET in `src/global.json`." }],
      output: null,
    },
    {
      name: "setup-python with python in .tool-versions",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-python@v6"),
        ".tool-versions": "nodejs 22.11.0\npython 3.13.1\n",
      },
      errors: [{ line: 7, messageIncludes: "The repository declares Python in `.tool-versions`." }],
      output: null,
    },
    {
      name: "no version file: report without a fix",
      files: steps(CHECKOUT, "      - uses: actions/setup-node@v6"),
      errors: [{ line: 7, messageIncludes: "sets neither `node-version` nor `node-version-file`" }],
      output: null,
    },
    {
      name: "trap: two candidate files are ambiguous, so no fix",
      files: { [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-node@v6"), ".nvmrc": "22\n", ".node-version": "20\n" },
      errors: [{ line: 7, messageIncludes: "`actions/setup-node` sets neither `node-version` nor `node-version-file`, so the Node.js version already on the runner's PATH is used; runner image or provisioning changes can change that version. The repository declares Node.js in `.nvmrc`, `.node-version`." }],
      output: null,
    },
    {
      name: "trap: checkout into a sub-path means the file is not at the workspace root, so no fix",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "        with:", "          path: app", "      - uses: actions/setup-node@v6"),
        ".nvmrc": "22\n",
      },
      errors: [{ line: 9, messageIncludes: "`actions/setup-node` sets neither `node-version` nor `node-version-file`, so the Node.js version already on the runner's PATH is used; runner image or provisioning changes can change that version. The repository declares Node.js in `.nvmrc`." }],
      output: null,
    },
    {
      name: "setup-node v6 can read a devEngines Node runtime version from package.json",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-node@v6"),
        "package.json": JSON.stringify({ devEngines: { runtime: [{ name: "node", version: "22" }] } }),
      },
      errors: [{ messageIncludes: "The repository declares Node.js in `package.json`." }],
      output: null,
    },
    {
      name: "setup-node v3 can read a Volta Node version",
      files: {
        [WORKFLOW]: steps(CHECKOUT, "      - uses: actions/setup-node@v3"),
        "package.json": JSON.stringify({ volta: { node: "22.14.0" } }),
      },
      errors: [{ messageIncludes: "The repository declares Node.js in `package.json`." }],
      output: null,
    },
  ],
});
