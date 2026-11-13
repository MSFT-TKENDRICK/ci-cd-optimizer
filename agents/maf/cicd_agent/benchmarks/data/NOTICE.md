# Benchmark data notice

The JSONL files in this directory are small, deterministic subsets of published open benchmarks. They are
redistributed under their original licenses for reproducible evaluation of the MAF agent. They are not the
full benchmarks, and scores on them are not comparable to published leaderboard numbers.

| File | Upstream | Revision | License | Upstream file sha256 | Subset sha256 |
|---|---|---|---|---|---|
| `ifeval.jsonl` | [google/IFEval](https://huggingface.co/datasets/google/IFEval) (Zhou et al., 2023, "Instruction-Following Evaluation for Large Language Models") | `966cd89545d6b6acfd7638bc708b98261ca58e84` | Apache-2.0 | `6a85310ca8ce15eff755aa08a3a4ff931c7e273e7515ebb3c492ea85fd8288f2` | `e4255d6e0d67ac487cc9b871f71bcdc0ac451438ff31f0f2153c9f208116d2d5` |
| `cruxeval.jsonl` | [cruxeval-org/cruxeval](https://huggingface.co/datasets/cruxeval-org/cruxeval) (Gu et al., 2024, "CRUXEval: A Benchmark for Code Reasoning, Understanding and Execution") | `b96af0450242eb4da433032b90998f25588a5d0f` | MIT | `8368b81047dc5014e4caf5a2f97604eff7644e0ecd7415e3ceeb184bbc2e0c96` | `310aa5666f051ab768d6ab314032f62b312cc81c259371aa9b3c1ff6dfccdf09` |

Rows are copied unmodified apart from the added `id` and `split` fields and the dropped fields not used for
grading. Regenerate them from the pinned upstream files with `build_subset` in `ifeval.py` and
`cruxeval.py`; both refuse an upstream file whose sha256 differs.

## Selection

- **Splits.** Each file has 60 rows, assigned round-robin to `train`, `val` and `test` (20 each). Hill-climb
  candidates are chosen on `train`, kept on `val`, and reported once on `test`.
- **IFEval.** Eligible rows are ordered by sha256 of their `key` and picked round-robin by first
  instruction id, giving 3 rows for each of the 20 supported instruction types.
- **CRUXEval.** The first 60 rows ordered by sha256 of their `id`. The task is CRUXEval-O (output
  prediction) with the reference direct-output prompt.

## Deviations from the reference harnesses

- **IFEval exclusions.** Rows with `language:response_language`, `length_constraints:number_sentences` or
  any `change_case:*` instruction are excluded. Their reference checks depend on langdetect or NLTK models
  this harness does not pin. Rows whose `keywords:letter_frequency` letter is not a-z are also excluded,
  because the reference replaces such a letter with a random one and so has no stable verdict.
- **IFEval parity.** The 20 ported checkers were compared with the reference `instructions.py` on 386
  eligible rows and 47,478 generated responses, with no verdict mismatches. Grading uses the reference
  *strict* rule.
- **CRUXEval grading without execution.** The answer is read with `ast.literal_eval`, and neither the
  dataset code nor the model output is executed. A correct but unsimplified expression, which the prompt
  forbids, fails here, although the reference harness would accept it. Scores are therefore a lower bound
  on reference pass@1.

## Repository-authored data

`grounding.json` (sha256 `1ea1a1b58283eead6c6762fd1f1e32e1915670c412bd30571415177d22861664`) is not an
upstream benchmark. It holds 6 small synthetic repositories (2 `train`, 2 `val`, 2 `test`) written for this
project and licensed MIT with the rest of the repository. It stores no expected answers. The expected rule
IDs are computed at run time by the bundled linter (`cicd-agents.mjs lint`), so the benchmark follows rule
changes instead of going stale. Scores measure whether the agent reports exactly the rule IDs the linter
returns for each repository. They are not comparable across bundle versions, so every result records the
bundle's sha256.
