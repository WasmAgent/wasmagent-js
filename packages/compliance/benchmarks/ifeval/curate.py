#!/usr/bin/env python3
"""
Curate a 50-sample subset of IFEval covering the top-15 instruction
classes by frequency. Stratified — every class appears at least 2x.

Input:  HF cache jsonl (540 samples, 25 classes)
Output: benchmarks/ifeval/samples.jsonl + provenance README

This script is deterministic — no randomness. Same input always yields
the same subset. Intended to be run once at curate time, not on every
benchmark run.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SRC = Path(
    os.environ.get(
        "IFEVAL_SRC",
        str(Path.home() / ".cache/huggingface/hub/datasets--google--IFEval/"
            "snapshots/966cd89545d6b6acfd7638bc708b98261ca58e84/ifeval_input_data.jsonl")
    )
)
OUT = REPO / "packages/compliance/benchmarks/ifeval/samples.jsonl"
README = REPO / "packages/compliance/benchmarks/ifeval/README.md"

# 15 classes we support in IFEvalVerifier Phase 0.
SUPPORTED_CLASSES = {
    "punctuation:no_comma",
    "length_constraints:number_words",
    "length_constraints:number_sentences",
    "keywords:forbidden_words",
    "detectable_format:number_highlighted_sections",
    "keywords:frequency",
    "combination:repeat_prompt",
    "startend:quotation",
    "change_case:english_lowercase",
    "keywords:existence",
    "detectable_format:title",
    "keywords:letter_frequency",
    "detectable_format:number_bullet_lists",
    "language:response_language",
    "detectable_content:number_placeholders",
}
TARGET_TOTAL = 50
MIN_PER_CLASS = 2


def main() -> int:
    if not SRC.exists():
        print(f"error: HF cache file not found at {SRC}", file=sys.stderr)
        return 1

    all_rows = []
    with SRC.open() as f:
        for line in f:
            row = json.loads(line)
            all_rows.append(row)

    # Phase 1: bucket by *primary* class (first instruction_id) so each
    # sample lives in exactly one bucket. Skip samples whose primary
    # class isn't supported.
    by_primary: dict[str, list[dict]] = {c: [] for c in SUPPORTED_CLASSES}
    for row in all_rows:
        ids = row.get("instruction_id_list") or []
        if not ids:
            continue
        primary = ids[0]
        if primary in by_primary:
            by_primary[primary].append(row)

    # Phase 2: stable-sort each bucket by key so the selection is
    # deterministic across runs.
    for bucket in by_primary.values():
        bucket.sort(key=lambda r: r["key"])

    # Phase 3: stratified pick. First, take MIN_PER_CLASS from each
    # class. Then top up by round-robin until we hit TARGET_TOTAL.
    selected: list[dict] = []
    cursor: dict[str, int] = {c: 0 for c in SUPPORTED_CLASSES}
    for c in sorted(SUPPORTED_CLASSES):
        bucket = by_primary[c]
        for _ in range(min(MIN_PER_CLASS, len(bucket))):
            if cursor[c] < len(bucket):
                selected.append(bucket[cursor[c]])
                cursor[c] += 1

    if len(selected) < TARGET_TOTAL:
        # Round-robin top-up — classes with more material absorb the
        # extras. Order: sorted class name → stable.
        classes_cycle = sorted(SUPPORTED_CLASSES)
        i = 0
        while len(selected) < TARGET_TOTAL:
            picked_any = False
            for c in classes_cycle:
                if len(selected) >= TARGET_TOTAL:
                    break
                if cursor[c] < len(by_primary[c]):
                    selected.append(by_primary[c][cursor[c]])
                    cursor[c] += 1
                    picked_any = True
            if not picked_any:
                # All buckets exhausted before hitting target — accept
                # the smaller subset rather than crash.
                break
            i += 1
            if i > 10:  # paranoia
                break

    # Phase 4: re-sort selected by key for a stable on-disk order.
    selected.sort(key=lambda r: r["key"])

    # Phase 5: filter each row's instruction_id_list down to the
    # supported classes only. Phase 0 IFEvalVerifier ignores unsupported
    # instructions; logging-only here.
    dropped_total = 0
    for row in selected:
        ids = row.get("instruction_id_list") or []
        kwargs = row.get("kwargs") or []
        kept_ids, kept_kwargs = [], []
        for iid, kw in zip(ids, kwargs):
            if iid in SUPPORTED_CLASSES:
                kept_ids.append(iid)
                kept_kwargs.append(kw)
            else:
                dropped_total += 1
        row["instruction_id_list"] = kept_ids
        row["kwargs"] = kept_kwargs

    # Drop samples that ended up with zero supported instructions.
    selected = [r for r in selected if r["instruction_id_list"]]

    # Phase 6: write outputs.
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        for row in selected:
            f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    sha = hashlib.sha256(OUT.read_bytes()).hexdigest()
    by_class: dict[str, int] = {}
    for row in selected:
        for iid in row["instruction_id_list"]:
            by_class[iid] = by_class.get(iid, 0) + 1

    readme = ["# IFEval — 50-sample subset", ""]
    readme.append(f"- Source: `google/IFEval` (HuggingFace), 540 samples")
    readme.append(f"- Curated: stratified by primary `instruction_id`, "
                  f"deterministic (no randomness)")
    readme.append(f"- Samples: {len(selected)}")
    readme.append(f"- sha256: `{sha}`")
    readme.append(f"- Cross-class instructions dropped (Phase 0 unsupported): "
                  f"{dropped_total}")
    readme.append("")
    readme.append("## Class coverage")
    readme.append("")
    readme.append("| instruction_id | count |")
    readme.append("|---|---|")
    for iid in sorted(by_class):
        readme.append(f"| `{iid}` | {by_class[iid]} |")
    readme.append("")
    readme.append("## Provenance")
    readme.append("")
    readme.append("Regenerate with:")
    readme.append("```")
    readme.append("python3 packages/compliance/benchmarks/ifeval/curate.py")
    readme.append("```")
    readme.append("")
    readme.append("The script is deterministic; the output sha256 is a "
                  "tripwire — if it changes, treat as a benchmark drift "
                  "and call out in a Changeset.")
    README.write_text("\n".join(readme) + "\n", encoding="utf-8")

    print(f"wrote {OUT} ({len(selected)} samples, sha256={sha[:16]}...)")
    print(f"wrote {README}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
