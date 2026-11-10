import rule from "../../../../src/lint/rules/toolchains/go-mod-mutable-override.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const GOMOD = { "go.mod": "module example.com/demo\n\ngo 1.24\n" };
const withGoflags = (goflags: string, ...steps: string[]): string =>
  yml("on: push", "env:", `  GOFLAGS: ${goflags}`, "jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", ...steps);

ruleTester(rule, {
  valid: [
    {
      name: "default -mod=readonly",
      files: { [WORKFLOW]: job("      - run: go build ./...", "      - run: go test -race ./..."), ...GOMOD },
    },
    {
      name: "-mod=vendor is not mutable",
      files: { [WORKFLOW]: job("      - run: go test -mod=vendor ./..."), ...GOMOD },
    },
    {
      name: "trap: tidy-check job inspects go.mod on purpose",
      files: {
        [WORKFLOW]: job("      - run: go mod tidy", "      - run: git diff --exit-code go.mod go.sum", "      - run: go build -mod=mod ./..."),
        ...GOMOD,
      },
    },
    {
      name: "trap: command-line -mod overrides GOFLAGS",
      files: { [WORKFLOW]: withGoflags("-mod=mod", "      - run: go test -mod=readonly ./..."), ...GOMOD },
    },
    {
      name: "trap: go install pkg@version ignores the main module",
      files: { [WORKFLOW]: withGoflags("-mod=mod", "      - run: go install golang.org/x/tools/cmd/goimports@v0.30.0"), ...GOMOD },
    },
    {
      name: "trap: go get of a remote module is not a local re-resolve",
      files: { [WORKFLOW]: job("      - run: go get example.com/tool@v1.2.3", "      - run: go build ./..."), ...GOMOD },
    },
    {
      name: "trap: workspace mode (go.work) is left alone",
      files: { [WORKFLOW]: job("      - run: go build -mod=mod ./..."), ...GOMOD, "go.work": "go 1.24\n\nuse .\n" },
    },
    {
      name: "trap: no go.mod in the repository",
      files: { [WORKFLOW]: job("      - run: go build -mod=mod ./...") },
    },
  ],
  invalid: [
    {
      name: "-mod=mod on go build",
      files: { [WORKFLOW]: job("      - run: go build -mod=mod ./..."), ...GOMOD },
      errors: [{ line: 7, path: WORKFLOW, messageIncludes: "`go build -mod=mod ./...` passes `-mod=mod`, permitting necessary updates to `go.mod`. This does not establish that the graph changes. Readonly mode rejects required go.mod updates but can still write go.sum." }],
      output: null,
    },
    {
      name: "GOFLAGS=-mod=mod in workflow env",
      files: { [WORKFLOW]: withGoflags("-mod=mod", "      - run: go test ./..."), ...GOMOD },
      errors: [{ line: 3, messageIncludes: "GOFLAGS is `-mod=mod`, so `go test ./...` may run with `-mod=mod` and update `go.mod` if needed. That is permission, not an observed graph change; readonly still permits some go.sum writes." }],
      output: null,
    },
    {
      name: "go env -w GOFLAGS before go vet",
      files: { [WORKFLOW]: job("      - run: go env -w GOFLAGS=-mod=mod", "      - run: go vet ./..."), ...GOMOD },
      errors: [{ line: 7, messageIncludes: "GOFLAGS is `-mod=mod`, so `go vet ./...`" }],
      output: null,
    },
    {
      name: "go get . before the build",
      files: { [WORKFLOW]: job("      - run: go get -v -t .", "      - run: go test ./..."), ...GOMOD },
      errors: [{ line: 7, messageIncludes: "`go get -v -t .` runs before `go test ./...`" }],
    },
  ],
});
