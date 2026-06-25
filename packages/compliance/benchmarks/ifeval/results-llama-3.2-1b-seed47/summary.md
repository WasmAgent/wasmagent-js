# IFEval Compliance Sweep — Results

- Model: `llama-3.2-1b`
- Samples: 50 (from `packages/compliance/benchmarks/ifeval/samples.jsonl`)
- Modes: direct, prompt_retry, full_pcl
- Wall-clock: 346.0s

## Per-mode aggregates

| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50 | 22 | 44.0% | 0 | 0.00 | 54 | 319 | 0 | 373 | 1458 |
| prompt_retry | 50 | 31 | 62.0% | 0 | 0.56 | 54 | 319 | 403 | 776 | 3295 |
| full_pcl | 50 | 27 | 54.0% | 0 | 1.52 | 54 | 319 | 386 | 759 | 2162 |

> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics.

## Failure taxonomy (initial violations among failed runs)

### direct

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 6 |
| `combination:repeat_prompt` | 5 |
| `detectable_format:number_bullet_lists` | 4 |
| `startend:quotation` | 3 |
| `keywords:letter_frequency` | 3 |
| `keywords:frequency` | 2 |
| `change_case:english_lowercase` | 2 |
| `length_constraints:number_sentences` | 2 |
| `language:response_language` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:forbidden_words` | 1 |
| `keywords:existence` | 1 |
| `detectable_content:number_placeholders` | 1 |

### prompt_retry

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 5 |
| `length_constraints:number_words` | 5 |
| `keywords:letter_frequency` | 3 |
| `startend:quotation` | 2 |
| `detectable_format:number_bullet_lists` | 2 |
| `length_constraints:number_sentences` | 2 |
| `change_case:english_lowercase` | 1 |
| `detectable_format:number_highlighted_sections` | 1 |
| `language:response_language` | 1 |
| `keywords:frequency` | 1 |
| `detectable_content:number_placeholders` | 1 |

### full_pcl

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 6 |
| `detectable_format:number_bullet_lists` | 4 |
| `keywords:letter_frequency` | 3 |
| `combination:repeat_prompt` | 3 |
| `startend:quotation` | 2 |
| `keywords:frequency` | 2 |
| `length_constraints:number_sentences` | 2 |
| `language:response_language` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:forbidden_words` | 1 |
| `change_case:english_lowercase` | 1 |
| `detectable_content:number_placeholders` | 1 |

## How to interpret

- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run.
- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0.
- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`.
