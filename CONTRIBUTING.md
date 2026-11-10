# Contributing

Use Node.js 22 and install dependencies with `npm ci`.

Before opening a pull request, run:

```sh
npm run lint
npm test
npm run build
npm run assurance:check
npm run formal:setup
npm run formal:check
```

If you change `ui/setup`, run `npm run build:ui` and commit the regenerated `dist-setup/`; CI fails when it is stale.
`npm run preview:mcp` shows the panel in a stand-in MCP Apps host against a fake GitHub (see [docs/setup.md](docs/setup.md)).

New rules belong in `src/lint/rules`, must include focused tests, and should only
report a finding when they can provide concrete evidence and a practical
remediation.

Review each rule's claims and regenerate `formal/rule-assurance.json`, its compiled counterpart, and the reference
with `npm run assurance:generate` and `npm run docs:rules`. A catalogue entry is not a detector/performance proof.
Production source, dependency or proof-tool changes also require `npm run formal:generate`: it verifies the Dafny
models before regenerating the checked-in runtime and source/dependency build stamp. Never hand-edit generated
formal code or bypass a missing solver. [Formal verification](docs/formal-verification.md) specifies the contracts,
the trusted extraction/preprocessing boundary, and certificate checks.

To enroll a repository in the [project review program](docs/review-program/README.md), open a pull request that
touches only `projects/<name>/project.yaml`, using the `review-submission` pull request template. Changes to
`projects/`, `src/review/`, and the review workflows require code owner review.
