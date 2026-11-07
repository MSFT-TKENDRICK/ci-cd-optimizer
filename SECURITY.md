# Security policy

Please report vulnerabilities privately through GitHub Security Advisories.

The app reads repository build configuration and writes check runs. It does not
execute analyzed code. Deployments should keep GitHub App private keys in a
managed secret store, validate webhook signatures through Probot, use a
dedicated runtime identity, and avoid logging repository file contents.

## Project review program

The [project review program](docs/review-program/README.md) reviews only public repositories whose default branch
has a `.github/ci-cd-optimizer-review.yml` consent file that lists the submitter. Consent is re-verified on every
review. To opt out, delete that file, set `paused: true`, or open a pull request removing the project. Public reports
show security-sensitive findings as counts only. Maintainers get full detail by running the review locally, or
through private vulnerability reporting. We follow a 90-day disclosure deadline with a 14-day grace period for
sensitive findings we report privately. Vulnerabilities in the program itself (for example, workflow or comment
injection) should be reported here privately; see the [threat model](docs/review-program/threat-model.md).
