# IFEval Compliance Sweep — Results

- Model: `llama-3.2-1b`
- Samples: 50 (from `packages/compliance/benchmarks/ifeval/samples.jsonl`)
- Modes: direct, prompt_retry, full_pcl
- Wall-clock: 350.4s

## Per-mode aggregates

| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50 | 21 | 42.0% | 0 | 0.00 | 54 | 321 | 0 | 374 | 1465 |
| prompt_retry | 50 | 28 | 56.0% | 0 | 0.58 | 54 | 321 | 432 | 807 | 3371 |
| full_pcl | 50 | 28 | 56.0% | 0 | 1.52 | 54 | 321 | 393 | 767 | 2167 |

> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics.

## Failure taxonomy (initial violations among failed runs)

### direct

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 6 |
| `length_constraints:number_words` | 6 |
| `detectable_format:number_bullet_lists` | 4 |
| `startend:quotation` | 3 |
| `length_constraints:number_sentences` | 3 |
| `keywords:letter_frequency` | 3 |
| `keywords:existence` | 3 |
| `change_case:english_lowercase` | 2 |
| `detectable_content:number_placeholders` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `detectable_format:title` | 1 |
| `keywords:forbidden_words` | 1 |
| `language:response_language` | 1 |
| `keywords:frequency` | 1 |

### prompt_retry

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 6 |
| `length_constraints:number_words` | 5 |
| `startend:quotation` | 3 |
| `detectable_format:number_bullet_lists` | 3 |
| `length_constraints:number_sentences` | 3 |
| `keywords:letter_frequency` | 3 |
| `keywords:existence` | 3 |
| `detectable_format:title` | 1 |
| `change_case:english_lowercase` | 1 |
| `detectable_format:number_highlighted_sections` | 1 |
| `language:response_language` | 1 |

### full_pcl

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 5 |
| `detectable_format:number_bullet_lists` | 4 |
| `length_constraints:number_sentences` | 3 |
| `keywords:letter_frequency` | 3 |
| `combination:repeat_prompt` | 3 |
| `startend:quotation` | 2 |
| `change_case:english_lowercase` | 2 |
| `detectable_content:number_placeholders` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:existence` | 2 |
| `language:response_language` | 1 |
| `keywords:frequency` | 1 |

## How to interpret

- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run.
- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0.
- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`.
