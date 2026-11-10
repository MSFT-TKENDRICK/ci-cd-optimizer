import rule from "../../../../src/lint/rules/toolchains/uv-sync-unlocked.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const PROJECT = { "pyproject.toml": '[project]\nname = "demo"\nversion = "0.1.0"\n', "uv.lock": "version = 1\n" };

ruleTester(rule, {
  valid: [
    {
      name: "--frozen installs from the lock as-is",
      files: { [WORKFLOW]: job("      - run: uv sync --frozen"), ...PROJECT },
    },
    {
      name: "UV_LOCKED in the job env",
      files: {
        [WORKFLOW]: yml(
          "on: push",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-24.04",
          "    env:",
          "      UV_LOCKED: 1",
          "    steps:",
          "      - run: uv sync",
        ),
        ...PROJECT,
      },
    },
    {
      name: "trap: no committed uv.lock",
      files: { [WORKFLOW]: job("      - run: uv sync"), "pyproject.toml": '[project]\nname = "demo"\n' },
    },
    {
      name: "trap: dependency-bump job re-locks on purpose",
      files: { [WORKFLOW]: job("      - run: uv lock --upgrade", "      - run: uv sync"), ...PROJECT },
    },
    {
      name: "trap: standalone script run",
      files: { [WORKFLOW]: job("      - run: uv run scripts/release.py"), ...PROJECT },
    },
    {
      name: "trap: uv pip does not touch uv.lock",
      files: { [WORKFLOW]: job("      - run: uv pip install -r requirements.txt"), ...PROJECT },
    },
    {
      name: "trap: dynamic flags may already include --locked",
      files: { [WORKFLOW]: job("      - run: uv sync $UV_SYNC_FLAGS"), ...PROJECT },
    },
  ],
  invalid: [
    {
      name: "a prior locked sync does not constrain a later run",
      files: { [WORKFLOW]: job("      - run: uv sync --locked --all-extras", "      - run: uv run pytest"), ...PROJECT },
      errors: [{ line: 8, messageIncludes: "`uv run pytest` locks and syncs the project before running `pytest`, and without `--locked` uv may rewrite the inspected `uv.lock` when freshness checks require changes instead of rejecting the update. A compatible lock can remain unchanged; this does not establish an actual dependency change." }],
      output: null,
    },
    {
      name: "a prior lock check does not enforce a later sync's update policy",
      files: { [WORKFLOW]: job("      - run: uv lock --check", "      - run: uv sync"), ...PROJECT },
      errors: [{ line: 8, messageIncludes: "`uv sync` runs without `--locked`" }],
      output: null,
    },
    {
      name: "uv sync without --locked (one report per lockfile and job)",
      files: { [WORKFLOW]: job("      - run: uv sync --all-extras", "      - run: uv run pytest"), ...PROJECT },
      errors: [
        {
          line: 7,
          path: WORKFLOW,
          messageIncludes: "`uv sync --all-extras` runs without `--locked`, and uv re-locks the project before syncing, so it may rewrite the inspected `uv.lock` when freshness checks require changes instead of rejecting the update. A compatible lock can remain unchanged; this does not establish an actual dependency change.",
        },
      ],
      output: null,
    },
    {
      name: "uv run with no prior sync",
      files: { [WORKFLOW]: job("      - run: uv run pytest -q"), ...PROJECT },
      errors: [{ line: 7, messageIncludes: "`uv run pytest -q` locks and syncs the project before running `pytest`" }],
      output: null,
    },
    {
      name: "--locked after the target goes to the target",
      files: { [WORKFLOW]: job("      - run: uv run pytest --locked"), ...PROJECT },
      errors: [{ line: 7, messageIncludes: "(the `--locked` after `pytest` is passed to that command, not to uv)" }],
      output: null,
    },
    {
      name: "subproject lockfile through working-directory",
      files: {
        [WORKFLOW]: job("      - run: uv sync", "        working-directory: services/api"),
        "services/api/pyproject.toml": '[project]\nname = "api"\n',
        "services/api/uv.lock": "version = 1\n",
      },
      errors: [{ line: 7, messageIncludes: "`uv sync` runs without `--locked`, and uv re-locks the project before syncing, so it may rewrite the inspected `services/api/uv.lock` when freshness checks require changes instead of rejecting the update. A compatible lock can remain unchanged; this does not establish an actual dependency change." }],
      output: null,
    },
  ],
});
