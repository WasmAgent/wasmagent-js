# IFEval Compliance Sweep — Results

- Model: `llama-3.2-1b`
- Samples: 50 (from `packages/compliance/benchmarks/ifeval/samples.jsonl`)
- Modes: direct, prompt_retry, full_pcl
- Wall-clock: 349.5s

## Per-mode aggregates

| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50 | 25 | 50.0% | 0 | 0.00 | 54 | 334 | 0 | 387 | 1516 |
| prompt_retry | 50 | 28 | 56.0% | 0 | 0.50 | 54 | 334 | 388 | 776 | 3287 |
| full_pcl | 50 | 30 | 60.0% | 0 | 1.36 | 54 | 334 | 355 | 742 | 2184 |

> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics.

## Failure taxonomy (initial violations among failed runs)

### direct

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 5 |
| `length_constraints:number_words` | 5 |
| `startend:quotation` | 3 |
| `detectable_format:number_bullet_lists` | 3 |
| `keywords:letter_frequency` | 3 |
| `change_case:english_lowercase` | 2 |
| `length_constraints:number_sentences` | 2 |
| `keywords:existence` | 2 |
| `keywords:forbidden_words` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `detectable_format:title` | 1 |
| `language:response_language` | 1 |
| `keywords:frequency` | 1 |

### prompt_retry

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 5 |
| `length_constraints:number_words` | 5 |
| `startend:quotation` | 3 |
| `detectable_format:number_bullet_lists` | 3 |
| `keywords:letter_frequency` | 3 |
| `length_constraints:number_sentences` | 2 |
| `keywords:existence` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `detectable_format:title` | 1 |
| `change_case:english_lowercase` | 1 |
| `language:response_language` | 1 |
| `keywords:frequency` | 1 |

### full_pcl

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 5 |
| `detectable_format:number_bullet_lists` | 3 |
| `keywords:letter_frequency` | 3 |
| `combination:repeat_prompt` | 3 |
| `startend:quotation` | 2 |
| `length_constraints:number_sentences` | 2 |
| `keywords:forbidden_words` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `change_case:english_lowercase` | 1 |
| `keywords:existence` | 1 |
| `language:response_language` | 1 |
| `keywords:frequency` | 1 |

## How to interpret

- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run.
- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0.
- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`.
