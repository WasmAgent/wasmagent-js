# IFEval — 50-sample subset

- Source: `google/IFEval` (HuggingFace), 540 samples
- Curated: stratified by primary `instruction_id`, deterministic (no randomness)
- Samples: 50
- sha256: `038b9782ed9250f9ceac383a0507f9fb3f36ec169366818d058faa0991741a0d`
- Cross-class instructions dropped (Phase 0 unsupported): 1

## Class coverage

| instruction_id | count |
|---|---|
| `change_case:english_lowercase` | 7 |
| `combination:repeat_prompt` | 6 |
| `detectable_content:number_placeholders` | 4 |
| `detectable_format:number_bullet_lists` | 4 |
| `detectable_format:number_highlighted_sections` | 6 |
| `detectable_format:title` | 5 |
| `keywords:existence` | 4 |
| `keywords:forbidden_words` | 4 |
| `keywords:frequency` | 6 |
| `keywords:letter_frequency` | 4 |
| `language:response_language` | 3 |
| `length_constraints:number_sentences` | 5 |
| `length_constraints:number_words` | 14 |
| `punctuation:no_comma` | 5 |
| `startend:quotation` | 4 |

## Provenance

Regenerate with:
```
python3 packages/compliance/benchmarks/ifeval/curate.py
```

The script is deterministic; the output sha256 is a tripwire — if it changes, treat as a benchmark drift and call out in a Changeset.
