<!--
Project review submission. Open this template with ?template=review-submission.md on the compare URL.
See docs/review-program/README.md. The pull request must change exactly one file: projects/<name>/project.yaml.
-->

## Project review submission

- Project name (directory under `projects/`):
- Repository: https://github.com/OWNER/REPO

### Checklist

- [ ] This pull request changes exactly one file, `projects/<name>/project.yaml`, and nothing else.
- [ ] `name` equals the directory name and `repository_id` is the id from `gh api repos/OWNER/REPO --jq .id`.
- [ ] The repository is public, not a fork, and not archived.
- [ ] The repository's default branch contains `.github/ci-cd-optimizer-review.yml` with `registry: MSFT-TKENDRICK/ci-cd-optimizer`,
      `project: <name>`, and a `contacts` list that includes me, `primary_contact`, and every `auto_ccs` entry.
- [ ] `npm run cli -- review validate projects/<name>/project.yaml` passes locally.
- [ ] I understand that review results are posted publicly on this pull request with security-sensitive findings withheld,
      and that deleting the consent file or `project.yaml` opts the project out.

### Opting out instead?

Delete `projects/<name>/project.yaml` (only a listed contact may do this), or delete `.github/ci-cd-optimizer-review.yml`
from your repository, which stops reviews immediately.
