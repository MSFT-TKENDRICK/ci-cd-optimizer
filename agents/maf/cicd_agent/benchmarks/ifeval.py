"""IFEval (Zhou et al., 2023; Google Research, Apache-2.0): verifiable instruction following in chat.

A faithful port of the reference ``check_following`` semantics for 20 of the 25 instruction types, graded
with the reference *strict* rule: an instruction counts only when the stripped response is non-empty and its
check passes, and an item passes only when every instruction in it does. The reward is the fraction of
instructions followed (instruction-level accuracy).

Items with ``language:response_language`` (langdetect), ``length_constraints:number_sentences`` (NLTK punkt)
or any ``change_case:*`` (langdetect/tokenizer heuristics) are excluded, because their reference checks
depend on third-party models this harness does not pin. Items whose ``letter_frequency`` letter is not a-z
are excluded too: the reference replaces such letters with a random one, so it has no stable verdict.
Scores therefore describe this pinned subset only and are not comparable to published full-IFEval numbers.
"""
from __future__ import annotations

import collections
import json
import re
from collections.abc import Callable, Sequence
from pathlib import Path

from ..config import Paths
from ..policy import Policy
from ..tracing import Tracer
from . import ItemResult
from .chat import DATA_DIR, SPLITS, ClientFactory, load_rows, run_items, sha256_file, stable_key, write_jsonl

NAME = "ifeval"
SOURCE = {"dataset": "google/IFEval", "revision": "966cd89545d6b6acfd7638bc708b98261ca58e84",
          "file": "ifeval_input_data.jsonl", "license": "Apache-2.0",
          "sha256": "6a85310ca8ce15eff755aa08a3a4ff931c7e273e7515ebb3c492ea85fd8288f2"}

Check = Callable[[str, dict, str], bool]


def _compare(actual: int, threshold: int, relation: str) -> bool:
    if relation == "less than":
        return actual < threshold
    if relation == "at least":
        return actual >= threshold
    raise ValueError(f"unsupported relation {relation!r}")


def _existence(value: str, kw: dict, prompt: str) -> bool:
    return all(re.search(keyword, value, flags=re.IGNORECASE) for keyword in kw["keywords"])


def _frequency(value: str, kw: dict, prompt: str) -> bool:
    count = len(re.findall(kw["keyword"].strip(), value, flags=re.IGNORECASE))
    return _compare(count, kw["frequency"], kw["relation"])


def _forbidden(value: str, kw: dict, prompt: str) -> bool:
    return not any(re.search(r"\b" + word + r"\b", value, flags=re.IGNORECASE) for word in kw["forbidden_words"])


def _letter_frequency(value: str, kw: dict, prompt: str) -> bool:
    letters = collections.Counter(value.lower())
    count = letters[kw["letter"].strip().lower()]
    # The reference treats every relation other than "less than" as "at least".
    return count < kw["let_frequency"] if kw["let_relation"] == "less than" else count >= kw["let_frequency"]


def _number_paragraphs(value: str, kw: dict, prompt: str) -> bool:
    paragraphs = re.split(r"\s?\*\*\*\s?", value)
    count = len(paragraphs)
    for index, paragraph in enumerate(paragraphs):
        if not paragraph.strip():
            if index in (0, len(paragraphs) - 1):
                count -= 1
            else:
                return False
    return count == kw["num_paragraphs"]


def _number_words(value: str, kw: dict, prompt: str) -> bool:
    # The reference counts nltk RegexpTokenizer(r"\w+") tokens, which is exactly re.findall(r"\w+").
    return _compare(len(re.findall(r"\w+", value)), kw["num_words"], kw["relation"])


def _nth_paragraph_first_word(value: str, kw: dict, prompt: str) -> bool:
    paragraphs = re.split(r"\n\n", value)
    count = len(paragraphs) - sum(1 for paragraph in paragraphs if not paragraph.strip())
    nth = kw["nth_paragraph"]
    if nth > count:
        return False
    paragraph = paragraphs[nth - 1].strip()
    if not paragraph:
        return False
    word = paragraph.split()[0].strip().lstrip("'").lstrip('"')
    first = ""
    for letter in word:
        if letter in {".", ",", "?", "!", "'", '"'}:
            break
        first += letter.lower()
    return count == kw["num_paragraphs"] and first == kw["first_word"].lower()


def _placeholders(value: str, kw: dict, prompt: str) -> bool:
    return len(re.findall(r"\[.*?\]", value)) >= kw["num_placeholders"]


def _postscript(value: str, kw: dict, prompt: str) -> bool:
    marker = kw["postscript_marker"].strip()
    if marker == "P.P.S":
        pattern = r"\s*p\.\s?p\.\s?s.*$"
    elif marker == "P.S.":
        pattern = r"\s*p\.\s?s\..*$"
    else:
        pattern = r"\s*" + marker.lower() + r".*$"
    return bool(re.findall(pattern, value.lower(), flags=re.MULTILINE))


def _bullets(value: str, kw: dict, prompt: str) -> bool:
    stars = re.findall(r"^\s*\*[^\*].*$", value, flags=re.MULTILINE)
    dashes = re.findall(r"^\s*-.*$", value, flags=re.MULTILINE)
    return len(stars) + len(dashes) == kw["num_bullets"]


def _constrained(value: str, kw: dict, prompt: str) -> bool:
    value = value.strip()
    return any(option in value for option in ("My answer is yes.", "My answer is no.", "My answer is maybe."))


def _highlights(value: str, kw: dict, prompt: str) -> bool:
    count = sum(1 for h in re.findall(r"\*[^\n\*]*\*", value) if h.strip("*").strip())
    count += sum(1 for h in re.findall(r"\*\*[^\n\*]*\*\*", value) if h.removeprefix("**").removesuffix("**").strip())
    return count >= kw["num_highlights"]


def _sections(value: str, kw: dict, prompt: str) -> bool:
    sections = re.split(r"\s?" + kw["section_spliter"].strip() + r"\s?\d+\s?", value)
    return len(sections) - 1 >= kw["num_sections"]


def _json(value: str, kw: dict, prompt: str) -> bool:
    value = (value.strip().removeprefix("```json").removeprefix("```Json").removeprefix("```JSON")
             .removeprefix("```").removesuffix("```").strip())
    try:
        json.loads(value)
    except ValueError:
        return False
    return True


def _title(value: str, kw: dict, prompt: str) -> bool:
    return any(title.lstrip("<").rstrip(">").strip() for title in re.findall(r"<<[^\n]+>>", value))


def _two_responses(value: str, kw: dict, prompt: str) -> bool:
    responses = value.split("******")
    valid = []
    for index, response in enumerate(responses):
        if not response.strip():
            if index not in (0, len(responses) - 1):
                return False
        else:
            valid.append(response)
    return len(valid) == 2 and valid[0].strip() != valid[1].strip()


def _repeat_prompt(value: str, kw: dict, prompt: str) -> bool:
    return value.strip().lower().startswith(kw["prompt_to_repeat"].strip().lower())


def _end_checker(value: str, kw: dict, prompt: str) -> bool:
    return value.strip().strip('"').lower().endswith(kw["end_phrase"].strip().lower())


def _quotation(value: str, kw: dict, prompt: str) -> bool:
    value = value.strip()
    return len(value) > 1 and value[0] == '"' and value[-1] == '"'


def _no_comma(value: str, kw: dict, prompt: str) -> bool:
    return "," not in value


CHECKERS: dict[str, Check] = {
    "keywords:existence": _existence,
    "keywords:frequency": _frequency,
    "keywords:forbidden_words": _forbidden,
    "keywords:letter_frequency": _letter_frequency,
    "length_constraints:number_paragraphs": _number_paragraphs,
    "length_constraints:number_words": _number_words,
    "length_constraints:nth_paragraph_first_word": _nth_paragraph_first_word,
    "detectable_content:number_placeholders": _placeholders,
    "detectable_content:postscript": _postscript,
    "detectable_format:number_bullet_lists": _bullets,
    "detectable_format:constrained_response": _constrained,
    "detectable_format:number_highlighted_sections": _highlights,
    "detectable_format:multiple_sections": _sections,
    "detectable_format:json_format": _json,
    "detectable_format:title": _title,
    "combination:two_responses": _two_responses,
    "combination:repeat_prompt": _repeat_prompt,
    "startend:end_checker": _end_checker,
    "startend:quotation": _quotation,
    "punctuation:no_comma": _no_comma,
}
SUPPORTED = frozenset(CHECKERS)


def _reference_deterministic(instruction: str, kwargs: dict) -> bool:
    # The reference substitutes random.choice(ascii_letters) for any letter outside a-z, so it has no stable verdict.
    if instruction == "keywords:letter_frequency":
        letter = kwargs.get("letter") or ""
        return len(letter) == 1 and "a" <= letter.lower() <= "z"
    return True


def eligible(row: dict) -> bool:
    ids = row["instruction_id_list"]
    return bool(ids) and all(i in SUPPORTED and _reference_deterministic(i, kw)
                             for i, kw in zip(ids, row["kwargs"], strict=True))


def grade(row: dict, response: str) -> tuple[bool, float, dict]:
    followed = [bool(response.strip()) and CHECKERS[instruction](response, kwargs, row["prompt"])
                for instruction, kwargs in zip(row["instruction_id_list"], row["kwargs"], strict=True)]
    reward = sum(followed) / len(followed)
    return all(followed), round(reward, 4), {
        "instructions": [[i, f] for i, f in zip(row["instruction_id_list"], followed)]}


def build_subset(source: Path, out: Path | None = None, n: int = 60) -> str:
    """Deterministic, stratified subset: hash-ordered rows, round-robin over first instruction id."""
    if sha256_file(source) != SOURCE["sha256"]:
        raise ValueError(f"{source} is not the pinned {SOURCE['dataset']}@{SOURCE['revision']} file")
    rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    pools: dict[str, list[dict]] = collections.defaultdict(list)
    for row in sorted(filter(eligible, rows), key=lambda r: stable_key(str(r["key"]))):
        pools[row["instruction_id_list"][0]].append(row)
    picked: list[dict] = []
    while len(picked) < n and any(pools.values()):
        for first in sorted(pools):
            if pools[first] and len(picked) < n:
                picked.append(pools[first].pop(0))
    subset = [{"id": f"ifeval-{row['key']}", "key": row["key"], "split": SPLITS[i % len(SPLITS)],
               "prompt": row["prompt"], "instruction_id_list": row["instruction_id_list"], "kwargs": row["kwargs"]}
              for i, row in enumerate(picked)]
    return write_jsonl(out or DATA_DIR / f"{NAME}.jsonl", subset)


def load_items(splits: Sequence[str] | None = None, data_dir: Path | None = None) -> list[dict]:
    return load_rows(NAME, splits, data_dir)


async def run(client_factory: ClientFactory, *, policy: Policy, tracer: Tracer, track: str = "baseline",
              candidate: str = "baseline", splits: Sequence[str] | None = None, model_name: str = "unknown",
              p: Paths | None = None, concurrency: int = 4, data_dir: Path | None = None) -> list[ItemResult]:
    return await run_items(NAME, load_items(splits, data_dir), lambda row: row["prompt"], grade, client_factory,
                           policy=policy, tracer=tracer, track=track, candidate=candidate, model_name=model_name,
                           p=p, concurrency=concurrency)
