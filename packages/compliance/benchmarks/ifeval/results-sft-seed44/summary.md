# IFEval Compliance Sweep — Results

- Model: `evomerge/checkpoints/sft-v1/sft_compliance_q4km.gguf`
- Samples: 50 (from `packages/compliance/benchmarks/ifeval/samples.jsonl`)
- Modes: direct, full_pcl
- Wall-clock: 377.6s

## Per-mode aggregates

| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50 | 20 | 40.0% | 0 | 0.00 | 54 | 325 | 0 | 379 | 2930 |
| full_pcl | 50 | 27 | 54.0% | 0 | 1.52 | 54 | 325 | 435 | 815 | 4616 |

> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics.

## Failure taxonomy (initial violations among failed runs)

### direct

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 6 |
| `combination:repeat_prompt` | 5 |
| `startend:quotation` | 4 |
| `punctuation:no_comma` | 4 |
| `length_constraints:number_sentences` | 3 |
| `keywords:letter_frequency` | 3 |
| `keywords:frequency` | 3 |
| `keywords:forbidden_words` | 2 |
| `change_case:english_lowercase` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:existence` | 2 |
| `language:response_language` | 1 |
| `detectable_format:title` | 1 |
| `detectable_format:number_bullet_lists` | 1 |

### full_pcl

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 6 |
| `startend:quotation` | 4 |
| `length_constraints:number_sentences` | 3 |
| `keywords:letter_frequency` | 3 |
| `keywords:frequency` | 3 |
| `keywords:forbidden_words` | 2 |
| `change_case:english_lowercase` | 2 |
| `combination:repeat_prompt` | 2 |
| `punctuation:no_comma` | 2 |
| `keywords:existence` | 2 |
| `detectable_format:number_highlighted_sections` | 1 |
| `language:response_language` | 1 |
| `detectable_format:number_bullet_lists` | 1 |

## How to interpret

- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run.
- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0.
- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`.
