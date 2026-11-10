import rule from "../../../../src/lint/rules/toolchains/python-pip-no-hash-check.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const PINNED = "# pinned\nrequests==2.32.3\nurllib3==2.2.2  # transitive\n";

ruleTester(rule, {
  valid: [
    {
      name: "requirements already carry hashes",
      files: {
        [WORKFLOW]: job("      - run: pip install -r requirements.txt"),
        "requirements.txt": "requests==2.32.3 \\\n    --hash=sha256:aaaa\n",
      },
    },
    {
      name: "--require-hashes on the command line",
      files: { [WORKFLOW]: job("      - run: pip install --require-hashes -r requirements.txt"), "requirements.txt": PINNED },
    },
    {
      name: "trap: ranges are not fully pinned",
      files: { [WORKFLOW]: job("      - run: pip install -r requirements.txt"), "requirements.txt": "requests>=2.31\nurllib3==2.2.2\n" },
    },
    {
      name: "trap: constraints file the rule cannot see through",
      files: {
        [WORKFLOW]: job("      - run: pip install -r requirements.txt -c constraints.txt"),
        "requirements.txt": PINNED,
        "constraints.txt": "idna==3.7\n",
      },
    },
    {
      name: "trap: positional package would need a hash too",
      files: { [WORKFLOW]: job("      - run: pip install -r requirements.txt ."), "requirements.txt": PINNED },
    },
    {
      name: "trap: nested -r include",
      files: { [WORKFLOW]: job("      - run: pip install -r requirements.txt"), "requirements.txt": "-r base.txt\nrequests==2.32.3\n" },
    },
    {
      name: "trap: PIP_REQUIRE_HASHES in the job env",
      files: {
        [WORKFLOW]: yml(
          "on: push",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-24.04",
          "    env:",
          "      PIP_REQUIRE_HASHES: 1",
          "    steps:",
          "      - run: pip install -r requirements.txt",
        ),
        "requirements.txt": PINNED,
      },
    },
    {
      name: "trap: requirements file not in the repository",
      files: { [WORKFLOW]: job("      - run: pip install -r requirements.txt") },
    },
  ],
  invalid: [
    {
      name: "pip install -r with pinned, hash-free requirements",
      files: { [WORKFLOW]: job("      - run: pip install -r requirements.txt"), "requirements.txt": PINNED },
      errors: [
        {
          line: 7,
          path: WORKFLOW,
          messageIncludes: "`pip install -r requirements.txt` installs 2 requirements pinned with `==` from `requirements.txt`, with no hashes or hash-checking mode visible in the inspected inputs. Version pins alone do not authenticate archive bytes; verify whether external pip policy already enforces this.",
        },
      ],
    },
    {
      name: "python -m pip with extras, markers and an index option",
      files: {
        [WORKFLOW]: job("      - name: Install", "        run: python -m pip install --upgrade-strategy eager -r requirements/ci.txt"),
        "requirements/ci.txt": '--index-url https://pypi.org/simple\nuvicorn[standard]==0.30.1 ; python_version >= "3.9"\n',
      },
      errors: [{ line: 8, messageIncludes: "installs 1 requirement pinned with `==` from `requirements/ci.txt`" }],
    },
    {
      name: "working-directory resolves the requirements file",
      files: {
        [WORKFLOW]: job("      - run: pip3 install -r requirements.txt -r requirements-dev.txt", "        working-directory: backend"),
        "backend/requirements.txt": PINNED,
        "backend/requirements-dev.txt": "pytest==8.3.2\n",
      },
      errors: [{ line: 7, messageIncludes: "installs 3 requirements pinned with `==` from `backend/requirements.txt`, `backend/requirements-dev.txt`" }],
    },
  ],
});
