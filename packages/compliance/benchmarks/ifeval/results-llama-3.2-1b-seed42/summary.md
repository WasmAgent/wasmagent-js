# IFEval Compliance Sweep — Results

- Model: `llama-3.2-1b`
- Samples: 50 (from `/Users/I041705/github/wasmagent-js/packages/compliance/benchmarks/ifeval/samples.jsonl`)
- Modes: direct, prompt_retry, full_pcl
- Wall-clock: 344.0s

## Per-mode aggregates

| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50 | 25 | 50.0% | 0 | 0.00 | 54 | 338 | 0 | 391 | 1526 |
| prompt_retry | 50 | 33 | 66.0% | 0 | 0.50 | 54 | 338 | 362 | 753 | 3217 |
| full_pcl | 50 | 29 | 58.0% | 0 | 1.34 | 54 | 338 | 343 | 735 | 2134 |

> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics.

## Failure taxonomy (initial violations among failed runs)

### direct

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 5 |
| `length_constraints:number_words` | 4 |
| `startend:quotation` | 3 |
| `detectable_format:number_highlighted_sections` | 3 |
| `detectable_format:number_bullet_lists` | 2 |
| `length_constraints:number_sentences` | 2 |
| `keywords:letter_frequency` | 2 |
| `detectable_content:number_placeholders` | 2 |
| `language:response_language` | 2 |
| `keywords:forbidden_words` | 2 |
| `keywords:existence` | 2 |
| `keywords:frequency` | 2 |
| `change_case:english_lowercase` | 1 |

### prompt_retry

| instruction_id | count |
|---|---|
| `combination:repeat_prompt` | 5 |
| `length_constraints:number_words` | 4 |
| `startend:quotation` | 2 |
| `length_constraints:number_sentences` | 2 |
| `keywords:letter_frequency` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:existence` | 2 |
| `detectable_format:number_bullet_lists` | 1 |
| `change_case:english_lowercase` | 1 |
| `keywords:forbidden_words` | 1 |
| `language:response_language` | 1 |

### full_pcl

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 4 |
| `startend:quotation` | 3 |
| `detectable_format:number_highlighted_sections` | 3 |
| `detectable_format:number_bullet_lists` | 2 |
| `length_constraints:number_sentences` | 2 |
| `keywords:letter_frequency` | 2 |
| `detectable_content:number_placeholders` | 2 |
| `language:response_language` | 2 |
| `combination:repeat_prompt` | 2 |
| `keywords:existence` | 2 |
| `keywords:frequency` | 2 |
| `change_case:english_lowercase` | 1 |
| `keywords:forbidden_words` | 1 |

## How to interpret

- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run.
- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0.
- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`.
