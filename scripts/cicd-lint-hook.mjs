#!/usr/bin/env node
// pre-commit entry point (`language: script` in .pre-commit-hooks.yaml). It runs the committed, self-contained Action
// bundle as `cicd-lint`, so the hook needs Node.js 22+ on PATH but no npm install or build step. CI keeps the bundle in
// sync with src/.
process.argv.splice(2, 0, "lint");
await import("../dist-action/index.js");
