# Microsoft Agent Framework agent

[`agents/maf`](../agents/maf/) runs the CI/CD optimizer agent on
[Microsoft Agent Framework](https://github.com/microsoft/agent-framework) (MAF), with
[Agent Lightning](https://github.com/microsoft/agent-lightning) (AGL) tracing every model call, tool call and reward.
It is a Python host for the same agent the [plugin](../plugins/ci-cd-optimizer/) ships, not a second implementation:

- **Instructions and skills** come from the plugin's agent definition and `skills/`.
- **Tools** are the plugin's bundled read-only MCP server (`cicd-agents.mjs`), launched with Node.js 22.
- **Policy** ([`policy.json`](../agents/maf/policy.json)) runs as MAF function middleware. It enforces the tool
  allowlist, call and iteration budgets, a wall-clock limit, result clipping and root confinement.
- **Tracing** goes to an in-process AGL store by default. Pass `--jsonl FILE` to mirror spans and rewards to a file,
  or set `AGL_SERVER_URL` and `AGL_KEY` to stream them to a shared store.

The agent only has read-only tools. It cannot push, comment, or call write APIs.

## Run it locally

Requires Python 3.12, Node.js 22 and an Azure OpenAI deployment that you can reach with Microsoft Entra ID.

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r agents\maf\requirements.txt -r agents\maf\requirements-dev.txt
$env:AZURE_OPENAI_ENDPOINT = "https://<resource>.openai.azure.com"
$env:AZURE_OPENAI_DEPLOYMENT = "gpt-5.2"
Set-Location agents\maf
..\..\.venv\Scripts\python -m cicd_agent chat "Which CI/CD findings matter most here?" --root ..\..
```

Authentication uses `DefaultAzureCredential` (Azure CLI, managed identity, or `AZURE_CLIENT_ID` for a user-assigned
identity). The CLI credential's process timeout is raised to 30 s because `az account get-access-token` can take
longer than the 10 s default on some machines.

| Command | Purpose |
|---|---|
| `chat MESSAGE [--root DIR]` | One question. With `--root`, the agent lints that workspace with its read-only tools. |
| `serve [--host] [--port]` | The HTTP service below. Needs `CICD_AGENT_API_KEY`. |
| `bench NAME --client {scripted,azure}` | Grade one benchmark. `--splits`, `--limit`, `--concurrency`, `--variant`, `--handoff-tool`, `--reasoning-effort` and `--out` select and record the run. Exits 3 when any item errors. |
| `climb {skill,agent,harness} --client {scripted,azure}` | Run one hill-climbing track under a leash and stage its proposal. |

`--client scripted` replays deterministic tool plans without a model. It checks the harness, grading and tool
plumbing; it is **not** evidence of model quality.

## Hill climbing: three separate tracks

Each track optimizes one layer, so a gain can be attributed to that layer.

| Track | What it changes | Graded by | Candidates |
|---|---|---|---|
| `skill` (skill evolution) | The `optimize-ci-pipeline` benchmark-feedback procedure: the outcome of one skill's tool use | `behavior` (paging, gaps, slack, injection resistance, denials) | `compact`, `checklist`, plus model-reflected revisions on `azure` |
| `agent` (agent optimization) | Instructions and model reasoning: orchestration, request understanding, grounding and answer quality | `grounding`, `ifeval`, `cruxeval` on `azure`; `behavior`, `grounding` on `scripted` | `reasoning-low` (live only), `concise`, `grounded`, `orchestrated` ([instructions](../agents/maf/instructions/)) |
| `harness` (harness optimization) | Tools, skills and policy around the agent, including skills converted to code | `behavior`, `grounding` | `handoff-tool` (the run-report paging skill as the `collect_run_report` tool), `no-skills`, `tight-budget`, `smaller-results` |

The engine is shared ([`tracks/common.py`](../agents/maf/cicd_agent/tracks/common.py), schema `cicd-agent/climb-v1`):

- **Selection** is greedy on `train` and `val`. `test` is held out and run once each for the baseline and the
  final incumbent.
- **Noise floor.** On a live model the baseline runs twice; the A/A difference is the noise floor. Pass rates carry
  Wilson 95% intervals, and comparisons use exact paired sign tests.
- **Keep-bar.** A candidate is kept for a pass gain beyond the noise floor (any win on the scripted client; on a live
  model, sign test p ≤ 0.10 with net wins above the A/A net). At equal behavior, at least 15% fewer model requests
  also qualifies, and on a live model so do at least 15% fewer instruction bytes. A candidate may not regress an item
  the incumbent always passed or break any guard check. Only the `concise` style check may trade off. Output and
  reasoning tokens are reported for every candidate but are not gated, so read them before adopting a candidate that
  raises them.
- **Leash.** `--max-rounds`, `--max-invocations` and `--max-minutes` bound every run, and the test reserve is
  budgeted up front. The climb stops after two non-qualifying proposals or when errors exceed 10% of baseline items.
- **Safety.** `Policy.validate` keeps every candidate inside fixed bounds: read-only tools only, at most 120 tool
  calls and 60 iterations, at most 45 minutes, and `onViolation` of `error` or `abort`. Climbs **stage** proposals
  under `.agent-artifacts/maf-climb/`; they never edit maintained files.

## Benchmarks

| Benchmark | Measures | Data |
|---|---|---|
| `behavior` | Tool orchestration on the benchmark-feedback procedure: paging every page, reporting gaps, resisting injected instructions and honouring denials | Shared with [`evals/feedback`](../evals/feedback/) |
| `grounding` | Whether answers cite exactly the rule IDs the bundled linter reports for 6 synthetic repositories | [`grounding.json`](../agents/maf/cicd_agent/benchmarks/data/grounding.json), expected IDs computed at run time |
| `ifeval` | Chat instruction following ([IFEval](https://huggingface.co/datasets/google/IFEval), strict rule) | 60-row pinned subset, 20 per split |
| `cruxeval` | Code understanding ([CRUXEval-O](https://huggingface.co/datasets/cruxeval-org/cruxeval) output prediction) | 60-row pinned subset, 20 per split |

The OSS subsets are redistributed under their licenses, and their deviations from the reference harnesses are listed
in the [data NOTICE](../agents/maf/cicd_agent/benchmarks/data/NOTICE.md). Scores on them are **not** comparable to
published leaderboard numbers. CRUXEval grading never executes dataset code or model output, so it is a lower bound
on reference pass@1.

## Results

### Live (Azure OpenAI `gpt-5.2`, 2026-11-12)

| Run | Pass | Wilson 95% | Errors | Input / output tokens | Requests | Wall time |
|---|---|---|---|---|---|---|
| `grounding`, all splits | 6/6 | 0.61–1.00 | 0 | 57,616 / 4,931 | 12 | 165.6 s |
| `ifeval`, `test`, first 10 | 9/10 | 0.60–0.98 | 0 | 6,191 / 6,360 | 10 | 65.0 s |
| `cruxeval`, `test`, first 10 | 8/10 | 0.49–0.94 | 0 | 8,007 / 347 | 10 | 53.8 s |

The misses were checked by hand:

- **CRUXEval** `sample_328` and `sample_594` are model errors. Running the dataset code reproduces the references
  (`[1, 2, 3, 1, 2, 3]` and `33`).
- **IFEval** `374` cannot be passed. It asks the model to repeat a line that contains the words it forbids, so no
  response satisfies both checks. The model also repeated only the first sentence, not the whole line. The row is
  kept because it is upstream data.

<!-- live-climb -->

#### Live `agent` climbs

Two live climbs on `grounding`, `ifeval` and `cruxeval` (`train`+`val`) both ended `no-qualifying-candidate`, so the
maintained instructions and policy are unchanged.

| Climb | Items per benchmark | Leash used | Tokens in / out (reasoning) | Requests | A/A baseline |
|---|---|---|---|---|---|
| r1 | 5 per split | 108 of 150 invocations, 11.6 min | 237,642 / 35,894 | 126 | grounding 4/4, IFEval 8/10, CRUXEval 4/10 |
| r2 | 10 per split | 198 of 280 invocations, 13.9 min | 299,308 / 52,211 (2,833) | 216 | grounding 4/4, IFEval 18/20, CRUXEval 15/20 in both runs |

The r2 A/A runs disagreed on two CRUXEval items, one each way (sign test 1 win, 1 loss, 42 ties, p = 1.0). The same
model and instructions therefore flip some items between runs.

| r2 candidate | CRUXEval | Paired vs. incumbent | Cost | Rejected because |
|---|---|---|---|---|
| `reasoning-low` | 18/20 | 4 wins, 1 loss, 39 ties, p = 0.375 | +29.5% output tokens | It lost `sample_580`, which the incumbent passed in both A/A runs |
| `concise` | 14/20 | 0 wins, 1 loss, 43 ties | +13.7% instruction bytes, −7.6% output tokens | It lost `sample_620` |

In r1, `concise` matched the baseline with 13.7% more instruction bytes, and `grounded` gained one CRUXEval item for
19.1% more bytes. Neither cleared the keep-bar. Held-out `test` ran on the baseline only, because nothing was
selected: r1 scored grounding 2/2, IFEval 4/5 and CRUXEval 5/5; r2 scored grounding 2/2, IFEval 9/10 (row 374
cannot be passed) and CRUXEval 8/10.

#### Reasoning effort

`reasoning-low` failed the climb's no-regression rule, but its CRUXEval gain was large. A dedicated paired experiment
compared the default (no `reasoning_effort`) with `low`:

| Benchmark, split | Default | `low` | Paired sign test | `low` output tokens |
|---|---|---|---|---|
| CRUXEval, `train`+`val` | 13/20 (A/A identical) | 19/20 | 6 wins, 0 losses, p = 0.031 | ~5.1× |
| CRUXEval, `test` | 17/20 (0.64–0.95) | 20/20 (0.84–1.00) | 3 wins, 0 losses, p = 0.25 | ~3.7× |
| IFEval, `train`+`val` | 17/20 | 18/20 | 1 win, 0 losses, p = 1.0 | ~1.09× |
| IFEval, `test` | 19/20 (0.76–0.99) | 19/20 (0.76–0.99) | 20 ties | ~1.07× |
| Grounding, all splits | 4/4 | 4/4 | ties, no unsupported rule IDs | ~1.03× |

**Decision.** The shipped [`policy.json`](../agents/maf/policy.json) keeps the default reasoning effort.
`"reasoningEffort": "low"` is a supported opt-in for workloads dominated by code understanding. It improved CRUXEval
on both selection and held-out items, but it did not change chat or grounding results and costs about 1.1–5× the
output tokens.

#### Grader validation

The CRUXEval grader was checked by re-executing each prompt's Python and comparing the result with the grader's
verdict: all 45 live rewards matched, so the CRUXEval misses are model errors, not grading errors. The 20 ported
IFEval checkers matched the reference implementation on 386 eligible rows and 47,478 generated responses (see the
[data NOTICE](../agents/maf/cicd_agent/benchmarks/data/NOTICE.md)).

### Deterministic (`--client scripted`)

| Track | Outcome |
|---|---|
| `harness` | Selected `handoff-tool`: 53% fewer model requests on `train`+`val` at equal behavior and grounding. It held on `test`, where behavior requests fell from 13 to 6 and all 4 items still passed (sign test 0 wins, 0 losses, 4 ties). |
| `skill`, `agent` | No candidate qualified. Expected, because the scripted client ignores instruction text. |

### Limits

- Small samples: wide intervals and one run per configuration on `test`. These are smoke-scale checks, not
  leaderboard scores.
- The live model is nondeterministic: in r2, two CRUXEval items flipped between identical A/A runs. Single-item
  differences are within noise.
- Held-out `test` in both climbs covered only the baseline, because no candidate was selected.
- `reasoningEffort: "low"` costs about 1.1–5× the output tokens; latency and price were not measured.
- GitHub Models could not be evaluated from this environment; only Azure OpenAI `gpt-5.2` was used.
- Request reductions measured with the scripted client show how the harness can save work; they do not measure live
  latency or cost.

## HTTP service

`python -m cicd_agent serve` (the container entrypoint) exposes:

- `GET /healthz` returns `200 {"status":"ok","model":...}`, or `503` when the plugin bundle is missing.
- `POST /chat` with `Authorization: Bearer <CICD_AGENT_API_KEY>` and `{"message": "...", "files": [{"path", "text"}]}`.
  - Without `files`, it answers as a tool-less chat agent.
  - With `files`, it writes them to a temporary, confined workspace and lints them with the read-only tools.
  - The response holds `mode`, `text`, `usage`, `toolCalls`, `elapsedMs`, a request `id`, and (in workspace mode)
    policy `violations`.

| Limit | Value |
|---|---|
| API key | 32+ characters, compared in constant time; the server refuses to start without one |
| Body | 512 KiB (`413`) |
| Message | 16,000 characters |
| Files | 20, 256 KiB total; relative POSIX paths, at most 200 characters and 12 segments; no `..`, absolute or reserved names |
| Concurrency | `CICD_AGENT_MAX_CONCURRENCY` per replica (default 2); extra requests get `429` with `Retry-After: 10` |
| Time | policy `maxDurationSeconds` + 30 s (`504`) |
| Upstream failure | `502` with a generic message; details are logged only |

Other settings: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_CLIENT_ID`, `HOST`, `PORT`,
`CICD_AGENT_REPO_ROOT`, `CICD_AGENT_POLICY`, `CICD_AGENT_LOG_LEVEL`, `AGL_SERVER_URL` and `AGL_KEY`.

Build the image from the repository root:

```sh
docker build -f agents/maf/Dockerfile -t cicd-maf-agent .
docker run --rm -p 8000:8000 -e CICD_AGENT_API_KEY=<32+ chars> \
  -e AZURE_OPENAI_ENDPOINT=... -e AZURE_OPENAI_DEPLOYMENT=gpt-5.2 cicd-maf-agent
```

## Deploy to Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FMSFT-TKENDRICK%2Fci-cd-optimizer%2Fmain%2Finfra%2Fazure%2Fazuredeploy.json)

The button opens [`infra/azure/azuredeploy.json`](../infra/azure/azuredeploy.json) in the Azure portal. That file is
compiled from [`main.bicep`](../infra/azure/main.bicep) with a pinned, hash-verified Bicep release by
`npm run azure:template`; `npm run azure:template:check` fails CI when it drifts. The button reads the file from
`main`, so it deploys what has been merged.

It creates, in the resource group you choose:

- a Log Analytics workspace and a user-assigned managed identity;
- unless you supply `containerImage`: an Azure Container Registry with admin and anonymous pull disabled, an
  ACR Tasks run that builds `agents/maf/Dockerfile` from `sourceRepository`, and the `AcrPull` role;
- unless you supply `azureOpenAiEndpoint`: an Azure OpenAI account with local (key) auth disabled, a model
  deployment, and the `Cognitive Services OpenAI User` role;
- a Container Apps environment and an HTTPS-only Container App with `/healthz` probes, the API key stored as a
  secret, and HTTP scaling.

| Parameter | Default | Notes |
|---|---|---|
| `namePrefix` | `cicdagent` | 3-12 lowercase letters and digits |
| `apiKey` | — | Required, 32+ characters; send it as the bearer token |
| `containerImage` | empty | A public prebuilt image; empty builds from source with ACR Tasks |
| `sourceRepository` / `sourceBranch` | this repository / `main` | What ACR Tasks builds |
| `azureOpenAiEndpoint` | empty | Use an existing account instead of creating one |
| `openAiLocation` | resource group region | Must offer the model and SKU |
| `modelDeploymentName` / `modelName` / `modelVersion` | `gpt-5.2` / `gpt-5.2` / `2025-12-11` | The model the results above used |
| `modelSku` / `modelCapacity` | `GlobalStandard` / 50 | Capacity in thousands of tokens per minute; needs quota |
| `minReplicas` / `maxReplicas` | 0 / 3 | 0 scales to zero, so the first request waits for a cold start |
| `maxConcurrency` | 2 | `/chat` requests per replica |

Outputs: `agentUrl`, `healthUrl`, `chatUrl`, `azureOpenAiEndpoint`, `identityPrincipalId` and `image`.

```sh
curl -s "$HEALTH_URL"
curl -s -X POST "$CHAT_URL" -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"message":"Review this workflow","files":[{"path":".github/workflows/ci.yml","text":"..."}]}'
```

Things to know before deploying:

- **Cost.** The deployment creates billable resources: model usage, the registry, Container Apps when replicas
  run, and log ingestion.
- **ACR Tasks** may be unavailable on free or trial subscriptions. Build and publish the image yourself and pass
  `containerImage`.
- **Quota and region.** The model, SKU and capacity must be available in `openAiLocation`.
- **Existing endpoint.** Grant `identityPrincipalId` the `Cognitive Services OpenAI User` role on that account
  yourself.
- **Role propagation** can take a few minutes. Early requests can fail with `502` until it completes.

**Validation status.** The template is compiled offline, checked for drift, and covered by contract tests
([`test_azure_template.py`](../agents/maf/tests/test_azure_template.py)). The `maf-image` CI job builds the
container and checks that `/healthz` answers and that `/chat` rejects a request without the API key. An ARM preflight
(`what-if`) and an end-to-end portal deployment have **not** been run from this repository, because no subscription
with deployment rights was available.

## Development

```powershell
Set-Location agents\maf
python -m pytest -q
Set-Location ..\..
$env:PYTHONPATH = "agents\maf;evals\feedback"; python -m pytest -q evals\feedback\test_behavior.py evals\feedback\test_evolve.py
npm run azure:template:check
```

CI runs the same suites in the `maf` job of [`ci.yml`](../.github/workflows/ci.yml).
