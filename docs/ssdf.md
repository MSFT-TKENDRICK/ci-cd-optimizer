# NIST SSDF v1.1 repository evidence

The `ssdf` preset adds static checks for selected controls from [NIST SP 800-218, Secure Software Development Framework (SSDF) Version 1.1](https://csrc.nist.gov/pubs/sp/800/218/final). A repository evidence report covers the complete 42-task catalog:

```sh
ci-cd-optimizer ssdf
ci-cd-optimizer ssdf --format json --output ssdf-evidence.json
ci-cd-optimizer ssdf --repo owner/name --format json
ci-cd-optimizer lint --preset ssdf
```

Without `--repo`, the command assesses the current checkout and honors its linter configuration and inventory limits. With `--repo`, it reads the selected ref (default: repository default branch) through the GitHub API using the CLI token and that ref's configuration.

The `ssdf` preset is opt-in. The `all` preset also includes its rules. The report classifies tasks as:

| Status | Meaning |
| --- | --- |
| `evidence-observed` | A supported repository-visible signal was found. Effectiveness, coverage, and enforcement may still need verification. |
| `gap` | A recognized rule found a repository-visible concern, such as a publishing job without recognized provenance evidence. This is not a definitive compliance failure. |
| `unknown` | The scan cannot establish the control or did not find supported evidence. An incomplete inventory explicitly limits absence-based assessment. |
| `requires-attestation` | The task depends on organizational or operational evidence that repository files alone cannot establish. |

The initial checks look for publication provenance and SBOM evidence, attestation permissions, and static cloud credentials. Vulnerability scanning alone is not SBOM-generation evidence. The report also recognizes limited signals such as `CODEOWNERS`, dependency review, CodeQL, and dependency-update configuration. A `SECURITY.md` path is recorded, but RV.1.3 remains `unknown`: filename presence does not establish a vulnerability-disclosure policy, and its contents and operation are not assessed. These signals do not verify whether settings are enabled, checks are enforced, findings are triaged, or procedures are followed.

The GitHub App does not request organization or repository administration permissions for this report. Consequently, branch protection, rulesets, Actions settings, environment protection, runner configuration, identity-provider trust, artifact retention, and other API-inaccessible or external controls remain unknown or require attestation. Do not interpret evidence counts as a compliance score.

See the [GitHub Learn SSDF scenario](https://learn.github.com/well-architected/scenarios/nist-ssdf-implementation) for implementation context. The report is a triage aid and does not replace a formal assessment, audit, or legal determination.
