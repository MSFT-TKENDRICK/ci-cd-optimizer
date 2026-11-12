---
description: Evolve only the benchmark feedback skill with reviewed evidence and strict validation gates.
---

Apply the SkillOpt-Lite skill-only loop to the existing
`plugins/ci-cd-optimizer/skills/optimize-ci-pipeline/references/benchmark-feedback.md`.
Do not treat this prompt or an MCP event as permission to expand the user's existing authorization.

1. Freeze a versioned train/validation/test task set before editing. Previously exposed test cases are regression cases, not a fresh holdout. Use only synthetic tasks or explicitly reviewed, redacted records; never harvest session history or credentials automatically.
2. Record the current skill and baseline. Classify train failures; propose one bounded procedural edit addressing a reproducible failure. Keep frontmatter, trust/authorization rules, commands, schemas, tool grants and graders fixed. Do not remove protections to improve a score.
3. Use `evals/feedback/evolve.py` with the pinned optional requirements and existing authorized Copilot authentication. It invokes official SkillOpt-Sleep consolidation and SkillOpt's strict validation gate, then checks per-case no-regression and test outcomes. Inspect infrastructure failures separately. Do not substitute mocks for model-quality evidence.
4. Accept only a strict validation improvement with complete evidence and no safety regression. Retain the incumbent on ties, failures or missing results. Keep rejected proposals and explanations in ignored artifacts, never by destructive reset.
5. Run the final test slice once after selection; do not train on its failures while continuing to call it held out. Report sample size, model observability and uncertainty. Synthetic decision scores do not prove native activation, successful tool execution or CI savings.
6. Stage a reviewable diff only. Synchronize native mirrors with `node scripts/sync-skills.mjs --write` and run the existing skill/broadcast regressions. Do not reload a live extension, install a schedule, merge or deploy without separate authorization.

Method reference: [SkillOpt-Lite](https://github.com/EvolvingLMMs-Lab/SkillOpt-Lite/tree/4cb4eeef1f95375a9179737ab94cf5e64b9647c6).
This is an adaptation for this benchmark, not an upstream universal runner.
