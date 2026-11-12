---
description: Improve benchmark prompt composition separately from skill training, preserving delivery and authorization.
---

Apply the HarnessOpt harness-only loop to `scripts/feedback-harness.mjs`, limited to trusted procedure loading,
fingerprinting and prompt composition. Freeze skill text during a harness round.

1. Reproduce the harness failure and classify it separately from model/skill failures.
2. Protect the immutable `feedbackInstructions` contract, event identity validation, repository allowlist,
   size limits, resource pagination, delivery/receipt ordering, acknowledgement, replay gaps, permissions and
   credentials. These are not optimization targets. Existing test assertions and scoring rules are denylisted.
3. Make the smallest composition change. Never load a candidate path, URL, instructions or tool grant from
   event JSON. New behavior tests may be added, but do not weaken existing tests.
4. Run `node --test test/setup/feedback-harness.node.mjs`, native mirror parity and changed-file lint before
   any model evaluation. Check hostile payload separation, denied acknowledgements and reconnect deduplication.
5. Compare complete baseline/candidate behavior with identical fixtures. Any protection regression, omitted
   evidence or infrastructure failure rejects promotion regardless of aggregate score. Retain snapshots and
   use a surgical patch to undo only this round's edits; never reset unrelated work.
6. Stop with a reviewed diff and an honest result. No automatic live reload, credential changes, schedules,
   CI dispatch solely for training, merges or deployment.

Method reference: [HarnessOpt loop](https://github.com/EvolvingLMMs-Lab/SkillOpt-Lite/blob/4cb4eeef1f95375a9179737ab94cf5e64b9647c6/harness_example/spreadsheetbench/.github/prompts/harnessopt-loop.prompt.md).
This is a repository-specific adaptation, not a separately installed optimizer engine.
