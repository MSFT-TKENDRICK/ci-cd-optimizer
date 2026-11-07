# Contributing

Use Node.js 22 and install dependencies with `npm ci`.

Before opening a pull request, run:

```sh
npm run lint
npm test
npm run build
```

If you change `ui/setup`, run `npm run build:ui` and commit the regenerated `dist-setup/`; CI fails when it is stale.
`npm run preview:mcp` shows the panel in a stand-in MCP Apps host against a fake GitHub (see [docs/setup.md](docs/setup.md)).

New rules belong in `src/rules`, must include focused tests, and should only
report a finding when they can provide concrete evidence and a practical
remediation.

To enroll a repository in the [project review program](docs/review-program/README.md), open a pull request that
touches only `projects/<name>/project.yaml`, using the `review-submission` pull request template. Changes to
`projects/`, `src/review/`, and the review workflows require code owner review.
