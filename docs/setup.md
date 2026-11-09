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

No `npm ci` or build is needed: the page is a prebuilt React app committed in `dist-setup/`.
Open the printed loopback URL in your signed-in browser.
The wizard guides each approval separately. A step list across the top shows progress, and the panel below it shows
only the current step. When a step finishes, the panel moves on to the next one by itself. Select a completed step in
the list to review it; **Back** and **Continue** then move between reviewed steps, and **Back to current step**
returns to the step that needs action. Steps that are not unlocked yet cannot be opened.

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

**Resume an existing App after a restart or update.** Once the App key and ID have been saved, use the App's slug
(the name in `github.com/apps/SLUG`), not another registration:

```sh
npm run setup -- --repo OWNER/REPOSITORY --resume-app APP-SLUG
```

Resume reads the public App identity, the saved ID variable, and repository secret **names only**. It rejects
a mismatched App or missing key instead of replacing credentials. GitHub secrets cannot be read back; the key
never leaves GitHub. If an assignment token is already saved, it is retained, not revalidated or overwritten.

Select **Verify installation** once. The page checks automatically every few seconds until the verification
finishes; **Check verification result** is also available as a manual fallback. This explicitly dispatches
the [verification-only workflow](../.github/workflows/cicd-optimizer-verify-app.yml) on the default branch,
using the saved key on the runner. It checks the same account, selected-repository scope, permissions, and repository
access as fresh setup, then revokes its temporary token. It does not scan, open issues or PRs, or assign agents.
An interrupted runner can leave that temporary token valid until GitHub's expiration, normally one hour.
The wizard checks the exact run ID returned by GitHub, its workflow, repository, branch, commit, and successful
verification step. Queued, failed, skipped, unrelated, or stale runs cannot advance setup.

If verification fails, open **View verification run** and inspect **Verify App installation**. The error distinguishes
an App-ID mismatch, wrong installation account, suspended installation, all-repository access, unrecognized scope,
and missing permissions. Do not change repository access based only on a generic failed-run
status. Only an explicit all-repository error calls for changing **Repository access** to **Only select repositories**;
the installation owner must approve that change. No verification failure automatically changes access or credentials.

The workflow and `scripts/setup-app.mjs` / `scripts/verify-app.mjs` must exist on the target repository's default
branch. This repository includes them; install them first when resuming in another repository.
If the default branch changes while dispatching, retry verification. Resuming itself performs no writes or
workflow dispatches. Installation and coding-agent authorization still require their separate owner actions.
Installation opens in a separate tab. Return to the current setup tab afterward, even if GitHub's old installation
callback points at an expired local session; verification does not depend on that callback.

The setup server binds only to `127.0.0.1`, requires its unguessable session token (the page sends it in an
`X-Setup-Session` header), validates registration state and form
origins, and expires after one hour. Its `Referrer-Policy: same-origin` preserves the browser's `Origin` on local
form submissions while suppressing referrers to GitHub. Missing, `null`, and foreign POST origins remain rejected.
Session cookie names are isolated by port, so opening another local setup or test tab cannot replace this session.
Keys and user tokens are never logged, returned to the browser, or written to
local files. Keep setup running until the key is saved: if it exits first, generate a replacement key in GitHub App
settings. A failed save can be retried while setup remains open. Stop it with Ctrl+C afterward.
Renew `COPILOT_ASSIGN_TOKEN` before expiry; rerun the credential-save command below to replace it. The next scan
retries pending findings. Installation authorization and coding-agent user authorization are different credentials.

This mode uses the repository's scheduled/event-driven Actions workflows, not a webhook service. It does **not**
deploy PostgreSQL, a webhook receiver, or a permanent OAuth refresh service.

The Actions-only manifest omits `hook_attributes` entirely. GitHub validates a webhook URL even when `active` is
`false`, so a loopback placeholder is rejected. Only the browser registration and installation callbacks use the
local server. If GitHub reports an unreachable `127.0.0.1` hook URL, update the checkout, restart setup, and open the
newly printed URL instead of resubmitting the old registration form.

If the page reports **This view is not authorized** or a local request answers **Forbidden**, open the exact URL
printed by `npm run setup` (or the panel's link) in a fresh tab instead of refreshing an action URL. An older setup
process using `Referrer-Policy: no-referrer` rejects even valid browser POSTs because they send `Origin: null`;
updating the checkout does not update a running process.
Before registration, restart setup from the updated checkout. After registration, keep the process open if the key
is unsaved: restarting discards it and requires a replacement key from GitHub App settings, not another registration.
If the key and ID are already saved, restart with `--resume-app APP-SLUG` and use the newly printed URL. This loads
the fixed browser policy on every page without retrieving the saved key or relying on a per-page browser workaround.

**Guided setup in Copilot chat (MCP App).** The same ceremony also renders as an interactive panel inside Copilot chat,
as an [MCP App](https://github.com/modelcontextprotocol/ext-apps) (a `ui://` resource) served by
[`mcp/setup-server.mjs`](../mcp/setup-server.mjs). It drives the same local state machine as `npm run setup`, so both
surfaces behave identically and share one implementation.

1. Run `npm ci`. Unlike the browser command above, the MCP server needs the dev dependencies.
2. Start Copilot from the repository root and trust the folder. [`.github/mcp.json`](../.github/mcp.json) registers
   the `cicd-optimizer-setup` server, and project servers load only in a trusted folder. Its `node mcp/setup-server.mjs`
   path is relative to the working directory. A session that was already running must be restarted to load it.
3. Ask Copilot to "set up the CI/CD Optimizer App for this repository". It calls `cicd_optimizer_setup`, optionally with
   `repo` and `resumeApp` (the App slug, to continue an App whose key is already saved). A host that advertises MCP Apps
   is expected to render the panel in chat; capability negotiation alone does not prove that it rendered.
4. Keep the panel visible for at least 12 seconds, then ask Copilot to call `cicd_optimizer_setup_status`. Until the
   view makes an authenticated state request, it reports **Panel connection: not confirmed**. A timestamped request
   confirms a tool round trip through the host's bridge, not visual correctness. Resource prefetches, status calls,
   rejected requests, and expired state reads do not count. The timestamp is historical, not a live heartbeat; opening
   a new setup resets it. Copilot must not call the panel-only tools itself to manufacture this evidence.

The server has been installed and its open/status tools called in Copilot Desktop. Visual rendering in Desktop
remains unvalidated; the stand-in host below provides separate browser evidence.

Run `npm run mcp` to start the server by hand when debugging. It speaks the protocol on stdout and logs to stderr.

| Tool | Model-visible | Purpose |
|---|---|---|
| `cicd_optimizer_setup` | yes | Opens the panel for `OWNER/REPOSITORY` (default: `GITHUB_REPOSITORY`, then the current checkout). |
| `cicd_optimizer_setup_status` | yes | Read-only progress report. It never returns links, keys or tokens. |
| `setup_get_state`, `setup_save_credentials`, `setup_verify`, `setup_check_verification`, `setup_run_scan` | no (`visibility: ["app"]`) | Called only by the panel. Each needs the panel's session, and each action also needs the confirmation from the panel's confirmation step. |

The panel cannot take a secret. No tool accepts a token, key or password, and **Authorize the coding agent** appears
in chat only as a link to the local setup page, where you paste the Copilot-licensed token into a password field.
GitHub's manifest flow redirects the browser back to the local server, so registration and installation also open
`127.0.0.1` links (through the host's open-link capability) while the setup is running, for at most one hour.
Hosts that do not advertise MCP Apps support get only the instruction to run `npm run setup -- --repo OWNER/REPOSITORY`
in a terminal: no session, state or URL is returned, and the panel-only tools reject every call.

The panel's session token is generated per setup and kept out of model-visible text. It travels in the tool result's
`structuredContent`, which the MCP Apps specification reserves for the UI. Hosts must also hide `visibility: ["app"]`
tools from the model. A host that ignored either rule could let the model press the panel's buttons (save the credentials
you already registered, verify, dispatch the scan). The server still rejects calls without the token, there is no tool
for secrets, and the failure mode is bounded by those three actions. `structuredContent` also carries the local setup
page link, so a host that exposed it to a model with an HTTP tool could reach the page's token endpoint, but only if the
model supplied a token itself, which a shell-capable model could already use directly.

The MCP server and `npm run setup` are developer tools. The production container image installs only runtime
dependencies, so it contains neither.

**Developing the setup panel.** The panel is one React app in [`ui/setup`](../ui/setup), built with Tailwind and
[shadcn/ui](https://ui.shadcn.com/) components. It renders both surfaces: HTTP for `npm run setup` and MCP for chat.
esbuild bundles it into the committed `dist-setup/` files, so setup needs no build step on the user's machine.

```sh
npm run typecheck:ui                # strict TypeScript for the panel and its tests
npm run build:ui                    # regenerate dist-setup/ after changing ui/setup
npm run check:ui                    # what CI runs: fails when dist-setup/ is stale
npm run test:setup                  # setup server and MCP server tests (node:test)
npx vitest run --project setup-ui   # component and hook tests
```

**Previewing the panel without Copilot.** `npm run preview:mcp` starts a stand-in MCP Apps host and prints its URL. It
renders the server's real `ui://` resource in a sandboxed, cross-origin iframe, bridged by the same `AppBridge` that
`@modelcontextprotocol/ext-apps` provides for hosts. By default it uses a fake GitHub (`acme/widgets`), so nothing leaves
your machine. It is a development aid and shows how a spec-compliant host renders the panel, not how Copilot does.

```sh
npm run preview:mcp                                                          # fake GitHub
npm run preview:mcp -- --real --repo OWNER/REPOSITORY --resume-app APP-SLUG  # read-only view of your real setup
```

`--real` uses your `gh` login and refuses every state-changing tool unless you also pass `--allow-actions`, which lets
the panel save credentials and dispatch workflows against the real repository. `--same-origin` serves the view from the
host's origin so a debugger can reach into it. That removes the isolation, so use it only for debugging. The host page
counts Content-Security-Policy violations from the view, and the count should stay at 0.

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
- **Experiments and recipes open pull requests too.** The experiment generator's `create` step fails with
  `403: GitHub Actions is not permitted to create or approve pull requests` unless the setting above is on or
  `CICD_OPTIMIZER_TOKEN` (§4) is set. Recipe rollout opens target pull requests with the App's token, but its
  compatibility-score pull request in this repository has the same requirement.
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
