# Project registry

Each directory here registers one public repository with the CI/CD optimizer project review program. A submission
pull request adds exactly one file, `projects/<name>/project.yaml`, validated against [`schema.json`](schema.json).

Read [docs/review-program/README.md](../docs/review-program/README.md) before submitting: the target repository must
also commit a consent file, `.github/ci-cd-optimizer-review.yml`, that names this registry, the project, and the
maintainers allowed to speak for it.

Check a file locally before opening the pull request:

```sh
npm run cli -- review validate projects/<name>/project.yaml
```
