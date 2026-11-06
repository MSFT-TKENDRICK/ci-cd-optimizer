# Production setup

CI being green covers the code. This checklist covers the repository settings, credentials, and access that a
deployment also needs. Steps marked **(owner)** create credentials or change who can access what, so a repository or
organization owner must do them.

## 1. Repository security

Under **Settings → Advanced Security**, turn on:

- Dependency graph
- Dependabot alerts
- Malware alerts
- Dependabot security updates

Leave **Grouped security updates** off; [.github/dependabot.yml](../.github/dependabot.yml) already groups version updates.

That file runs weekly version updates for npm, GitHub Actions, and the Dockerfile base images. The Actions updater skips
the compiled gh-aw `*.lock.yml` files; bump their `.md` sources and run `gh aw compile` instead.

npm updates to runtime dependencies change the bundled `dist-action/index.js`, and CI fails until the bundle is rebuilt
on the Dependabot branch:

```sh
gh pr checkout <number>
npm ci && npm run bundle
git commit -am "Rebuild dist-action" && git push
```

`package-lock.json` must resolve from `https://registry.npmjs.org/`. Dependabot can't authenticate to a private mirror,
so npm updates fail when the lockfile points at one, and CI checks for this. If you install through a mirror, rewrite
its `resolved` URL prefix to `https://registry.npmjs.org/` before committing. Because npm's default
`replace-registry-host=npmjs` still routes your own installs through your configured registry, local installs keep
working.

Dependabot bumps the `node` base image and `@types/node` only within the current major, because it can't update the
distroless `nodejs22` runtime stage. Move both Dockerfile stages, `.nvmrc`, and `@types/node` to a new Node major
together. `eslint` and `@eslint/js` share one update group, so their majors land in a single PR. TypeScript majors are
ignored until `typescript-eslint`'s peer range allows them; upgrade both by hand.

`package.json` `overrides` forces `minimatch` to `^11.0.1` for a security fix that eslint's own range (`^10`) excludes,
so Dependabot can't apply it. Drop the override once eslint depends on a patched minimatch.

Under **Settings → Actions → General**, keep **Workflow permissions** at *Read repository contents and packages
permissions*. Workflows request the write scopes they need.

## 2. Container image

Set the `GHCR_IMAGE` repository variable:

```sh
gh variable set GHCR_IMAGE --body ghcr.io/<owner>/ci-cd-optimizer
```

The [Container workflow](../.github/workflows/container.yml) then pushes the image on every push to `main` and every
`v*` tag. The image's `org.opencontainers.image.source` label links the package to the repository, so it inherits the
repository's access.

## 3. GitHub App (owner)

The App is needed for these:

- **Fix pull requests that edit `.github/workflows/**`.** `GITHUB_TOKEN` can't push those changes.
- **Fix and recipe pull requests that trigger CI.** Pull requests opened with `GITHUB_TOKEN` don't run workflows.
- **Cross-repository recipe rollout.**
- **The hosted, webhook-driven App.**

**Guided setup (Actions only, no hosting).** From a checkout, with Node 22+ and an authenticated
[GitHub CLI](https://cli.github.com/) that has repository admin access:

```sh
npm run setup -- --repo OWNER/REPOSITORY
```

No `npm ci` or TypeScript build is needed for setup. Open the printed loopback URL in your signed-in browser.
The wizard guides each approval separately:

1. Register a private App through GitHub's manifest flow (personal owner or organization). Change the proposed name
   on GitHub if it is already taken.
2. Save the generated key directly to `CICD_OPTIMIZER_APP_PRIVATE_KEY` and the ID to `CICD_OPTIMIZER_APP_ID`.
   The wizard explicitly confirms the target repository; saving replaces values with those names.
3. Install on **Only select repositories**, select the target, then verify using an App-authenticated,
   short-lived token scoped to that repository. The verification token is revoked immediately.
4. Authorize the coding agent separately with a Copilot-licensed user's fine-grained token: only the target repository,
   **Issues: read and write**, and an expiry. Paste it into the local password field, never into chat.
   The wizard validates user authentication and issue visibility and saves `COPILOT_ASSIGN_TOKEN`; a real assignment
   is still needed to verify write permission, the Copilot license, and organization policy.
5. Dispatch the existing `cicd-optimizer-scan.yml` workflow. Confirm the issue has Copilot as an assignee and a linked PR;
   the `copilot:ready` label alone means the handoff is pending. Other repositories must first install the
   [scan workflow](../examples/workflows/cicd-optimizer-scan.yml) and enable `issues.assignCopilot`.

The setup server binds only to `127.0.0.1`, requires its one-time session URL, validates registration state and form
origins, and expires after one hour. Keys and user tokens are never logged, returned to the browser, or written to
local files. Keep setup running until the key is saved: if it exits first, generate a replacement key in GitHub App
settings. A failed save can be retried while setup remains open. Stop it with Ctrl+C afterward.
Renew `COPILOT_ASSIGN_TOKEN` before expiry; rerun the credential-save command below to replace it. The next scan
retries pending findings. Installation authorization and coding-agent user authorization are different credentials.

This mode uses the repository's scheduled/event-driven Actions workflows, not a webhook service. It does **not**
deploy PostgreSQL, a webhook receiver, or a permanent OAuth refresh service.

**Manual fallback.** Open this prefilled registration page. Replace `<you>` with a globally unique suffix,
or use `https://github.com/organizations/<org>/settings/apps/new?...` for an organization:

```text
https://github.com/settings/apps/new?name=ci-cd-optimizer-<you>&url=https://github.com/MSFT-TKENDRICK/ci-cd-optimizer&public=false&webhook_active=false&actions=read&checks=write&contents=write&issues=write&pull_requests=write&security_events=write&workflows=write
```

1. Select **Create GitHub App** and note the App ID.
2. Under **Private keys**, select **Generate a private key**. This downloads a `.pem` file.
3. Select **Install App**, choose **Only select repositories**, and pick this repository plus any recipe targets.
4. Store the credentials, then delete the local key:

   ```sh
   gh variable set CICD_OPTIMIZER_APP_ID --body <app-id>
   gh secret set CICD_OPTIMIZER_APP_PRIVATE_KEY < key.pem
   ```

**Hosted App.** Register from [app.yml](../app.yml) and deploy the container. See
[github-app.md](github-app.md#register-the-app).

## 4. Optional tokens (owner)

Scope fine-grained personal access tokens to the repositories that need them, and set an expiry.

| Secret | When | Permissions |
|---|---|---|
| `CICD_OPTIMIZER_TOKEN` | Instead of the App, or for gh-aw `pipeline` experiments that change workflow files | Contents, Pull requests, Issues, Actions, Workflows: read and write |
| `COPILOT_ASSIGN_TOKEN` | Assigning finding issues to the Copilot coding agent. The token's user needs a Copilot license. | Issues: read and write |
| `COPILOT_GITHUB_TOKEN` | gh-aw experiments on an account without an organization Copilot subscription, where `copilot-requests: write` isn't available | Copilot Requests |

```sh
gh secret set CICD_OPTIMIZER_TOKEN
```

To authorize or renew coding-agent assignment:

```sh
gh secret set COPILOT_ASSIGN_TOKEN --repo OWNER/REPOSITORY
```

Enter the token at the hidden prompt. Do not copy a broad GitHub CLI login credential into this secret.

## 5. Actions access (owner)

- **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General). Turn this on only if
  `command: scan` runs with `GITHUB_TOKEN` and should open fix pull requests. Prefer the App.
- **Using the Action from other private repositories.** While this repository is private, set Settings → Actions →
  General → **Access** to *Accessible from repositories owned by the user* (or the organization). Public
  repositories don't need this.

## 6. Plan limits

Private repositories on GitHub Free have neither rulesets, branch protection, nor code scanning. CI/CD Optimizer
degrades gracefully: the SARIF upload reports `unavailable` and findings still arrive as pull request checks, issues,
and fix pull requests. To get alerts under **Security → Code scanning** and a protected `main`, make the repository
public, or move it to a plan that includes them (GitHub Advanced Security for private organization repositories).
Then add a ruleset on `main` that does all of these:

- requires pull requests
- requires the `CI` and `CI/CD Optimizer` checks
- blocks force pushes

## 7. Releases

Consumers pin a commit SHA (most secure) or the moving major tag `v0`. To release:

```sh
npm version <x.y.z> --no-git-tag-version && npm run bundle    # commit both, then:
gh release create v<x.y.z> --generate-notes
git tag -f v0 v<x.y.z> && git push -f origin v0
```

The tag push also publishes `ghcr.io/<owner>/ci-cd-optimizer:v<x.y.z>`.
