# Running the GitHub App

The App is the Dependabot-style, zero-workflow way to run CI/CD Optimizer across an organization. It reacts to webhooks
with the same service layer the [Action and CLI](../README.md#three-ways-to-run-it) use, so behavior and configuration
(`.github/ci-cd-optimizer.yml`) are identical. Use the App when you want installation-wide coverage without adding
workflows to every repository.

## What it does

| Webhook | Handler |
|---|---|
| `pull_request` opened, synchronize, reopened, ready_for_review | Runs the **CI/CD Optimizer** check. It annotates only findings the pull request introduces, compared with the base. |
| `check_run` rerequested | Re-runs that check. |
| `push` to the default branch that touches CI/CD files, or has 20+ commits | **Repository scan:** uploads SARIF to code scanning and syncs [finding issues and fix pull requests](issues-and-alerts.md). |
| `installation` created, `installation_repositories` added | Initial scan of each newly covered repository. |
| `workflow_run` completed | Records a telemetry snapshot. Posts the **CI/CD Telemetry (\<workflow\>)** check with the Gantt chart and bottlenecks, and syncs [duration alerts](issues-and-alerts.md#duration-alerts). |
| `issue_comment` created | `@cicd-optimizer` [commands](configuration.md#fix-pull-requests-fixes) on the App's fix and recipe pull requests, from repository owners, organization members, and collaborators. |

GitHub delivers installation events to every App, so they aren't listed in `default_events`.

## Register the App

[app.yml](../app.yml) is a [GitHub App manifest](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
with the minimum permissions:

| Permission | Access | Why |
|---|---|---|
| Actions | read | Workflow runs, and job and step timings for telemetry and alerts. |
| Checks | write | Pull request check and telemetry reports. |
| Contents | write | Read workflows and manifests; push fix pull request branches. |
| Issues | write | Finding and duration-alert issues. |
| Metadata | read | Required. |
| Pull requests | write | Fix and recipe pull requests and their commands. |
| Security events | write | SARIF upload to code scanning. |
| Workflows | write | Fix pull requests that edit `.github/workflows/**`. |

The fastest path uses Probot's manifest flow:

1. Set the webhook and setup URLs in `app.yml` to your deployment, replacing the `example.com` placeholders.
2. Run `npm ci && npm run build && npm start` with no `APP_ID`.
3. Open <http://localhost:3000> and register the App. Probot writes its credentials to `.env`.

You can also create the App manually under **Settings → Developer settings → GitHub Apps** with the permissions and
events above. The webhook path is `/api/github/webhooks`. For Actions-only use without hosting, the
[setup checklist](setup.md#3-github-app-owner) has a prefilled registration link.

## Configure

| Variable | Required | Purpose |
|---|---|---|
| `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` | yes | App credentials ([.env.example](../.env.example)). |
| `PORT`, `LOG_LEVEL` | no | HTTP port (default 3000) and log level. |
| `DATABASE_URL` | no | Postgres store for telemetry snapshots used as alert baselines and trend history. Without it, history is rebuilt from the Actions API on each run. The schema is created on first use. |
| `COPILOT_ASSIGN_TOKEN` | no | Token for a Copilot-licensed user, used to [assign issues to the Copilot coding agent](issues-and-alerts.md#assigning-issues-to-the-copilot-coding-agent). App installation tokens can't assign Copilot. Without this token, issues get the `copilot:ready` label instead. |
| `CICD_OPTIMIZER_UPLOAD_SARIF` | no | Set to `false` to skip code scanning uploads. Uploads fail softly when code scanning is unavailable, for example on private repositories without GitHub Advanced Security. |

## Deploy

The [Dockerfile](../Dockerfile) builds a distroless, non-root Node 22 image. The production dependency layer is cached
separately from the TypeScript build. The [Container workflow](../.github/workflows/container.yml) builds the image on
every push to `main` and every `v*` tag. Set the repository variable `GHCR_IMAGE` (for example
`ghcr.io/my-org/ci-cd-optimizer`) to push it to GitHub Container Registry. Images are tagged with the commit SHA and
with `main` or the release tag (such as `v0.2.0`), and labeled so the package is linked to the repository.

```sh
docker run -p 3000:3000 --env-file .env ghcr.io/my-org/ci-cd-optimizer:<sha>
```

Run it on any container host with a public HTTPS endpoint, such as Azure Container Apps, Kubernetes, or Cloud Run. The
process is stateless apart from the optional Postgres database, so it scales horizontally.

## App, Action, or both?

| Need | Use |
|---|---|
| Org-wide coverage with no per-repository setup, plus telemetry for every workflow | The App. |
| A required status check with SARIF in workflows you control, or no hosting | The Action ([examples](../examples/workflows)). |
| Hill-climbing experiments and recipe rollout | Workflows in this repository. The rollout uses the App's credentials to reach target repositories ([recipes](recipes.md#setup)). |

Running both is safe. The App and `command: scan` share the same scan, so issues (matched by hidden fingerprints), fix
pull requests (matched by branch), and code scanning alerts update the same items instead of creating duplicates.
