# Benchmark corpus

The ground truth for `rules` [experiments](../docs/experiments.md) and for regression testing the linter. Each case is a
small repository snapshot with the findings the linter should report on it.

```text
corpus/<case-id>/
├── case.yml        what to expect
└── files/**        the snapshot, linted as a repository root with every rule enabled
```

```yaml
# corpus/node-ci-unoptimized/case.yml
description: Single-package Node CI with every common pull request inefficiency.
rules: [workflow/concurrency, caching/setup-cache]   # rules scored for this case; default: the rules in expected, "*" for all
expected:                                           # every finding the scored rules should report
  - { rule: workflow/concurrency, path: .github/workflows/ci.yml }
  - { rule: caching/setup-cache, path: .github/workflows/ci.yml, line: 14 }   # line is optional
fixed:                                              # optional: file contents expected after autofix
  .github/workflows/ci.yml: |
    ...
change:                                             # optional: lint as a pull request with these changed paths
  event: pull_request
  changedPaths: [packages/web/src/index.ts]
inventoryComplete: true                             # false: files/ is a partial snapshot
```

Scoring for the scored rules:

- **Matching:** a finding matches an expected entry when the rule and path agree, and the line too when one is given.
  Unmatched findings are false positives, and unmatched expectations are false negatives.
- **Totals:** precision, recall, and F1 are computed over all cases.
- **Fix rate:** the share of fixable true positives that the autofix resolves, meaning a re-lint no longer reports them.
  When a case lists `fixed`, the autofixed files must also equal it exactly, or none of that case's fixes count.
- **Duration:** `durationMs` is the median time over `evaluation.timingRuns` passes.
- **Crashes:** a crashed case counts all of its expectations as missed, so a broken engine can't score as precise.

Run it:

```sh
npm run build
node dist-action/index.js experiments evaluate --engine dist/lint/api.js --corpus corpus
```

Rules for adding cases:

- Keep each case minimal and focused on one pattern. Cover both directions: a case that should be reported, and an
  optimized case that should stay clean.
- Cases are immutable once merged. Fix a wrong expectation by adding a new case and deleting the old one in a reviewed
  pull request to `main`.
- Experiments may add up to 10 cases (50 files each, 200 KB total) on their trunk before arms branch. Arms can't touch
  `corpus/**`.
