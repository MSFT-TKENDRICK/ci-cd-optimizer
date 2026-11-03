# Contributing

Use Node.js 22 and install dependencies with `npm ci`.

Before opening a pull request, run:

```sh
npm run lint
npm test
npm run build
```

New rules belong in `src/rules`, must include focused tests, and should only
report a finding when they can provide concrete evidence and a practical
remediation.
