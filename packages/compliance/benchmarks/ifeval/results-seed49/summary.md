# IFEval Compliance Sweep — Results

- Model: `qwen2.5-1.5b`
- Samples: 50 (from `/Users/I041705/github/wasmagent-js/packages/compliance/benchmarks/ifeval/samples.jsonl`)
- Modes: direct, prompt_retry, full_pcl
- Wall-clock: 1129.8s

## Per-mode aggregates

| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50 | 22 | 44.0% | 0 | 0.00 | 54 | 263 | 0 | 317 | 4364 |
| prompt_retry | 50 | 24 | 48.0% | 0 | 0.56 | 54 | 263 | 429 | 746 | 11759 |
| full_pcl | 50 | 28 | 56.0% | 0 | 1.46 | 54 | 263 | 306 | 623 | 6465 |

> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics.

## Failure taxonomy (initial violations among failed runs)

### direct

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 8 |
| `combination:repeat_prompt` | 4 |
| `punctuation:no_comma` | 4 |
| `keywords:letter_frequency` | 4 |
| `keywords:frequency` | 3 |
| `change_case:english_lowercase` | 3 |
| `length_constraints:number_sentences` | 3 |
| `startend:quotation` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:forbidden_words` | 2 |
| `keywords:existence` | 2 |
| `detectable_format:title` | 1 |
| `detectable_format:number_bullet_lists` | 1 |
| `language:response_language` | 1 |
| `detectable_content:number_placeholders` | 1 |

### prompt_retry

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 7 |
| `combination:repeat_prompt` | 4 |
| `punctuation:no_comma` | 4 |
| `keywords:letter_frequency` | 4 |
| `keywords:frequency` | 3 |
| `change_case:english_lowercase` | 3 |
| `length_constraints:number_sentences` | 3 |
| `startend:quotation` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:forbidden_words` | 2 |
| `keywords:existence` | 2 |
| `detectable_format:title` | 1 |
| `language:response_language` | 1 |
| `detectable_content:number_placeholders` | 1 |

### full_pcl

| instruction_id | count |
|---|---|
| `length_constraints:number_words` | 8 |
| `keywords:letter_frequency` | 4 |
| `keywords:frequency` | 3 |
| `length_constraints:number_sentences` | 3 |
| `startend:quotation` | 2 |
| `combination:repeat_prompt` | 2 |
| `detectable_format:number_highlighted_sections` | 2 |
| `keywords:forbidden_words` | 2 |
| `punctuation:no_comma` | 2 |
| `keywords:existence` | 2 |
| `detectable_format:number_bullet_lists` | 1 |
| `change_case:english_lowercase` | 1 |
| `language:response_language` | 1 |
| `detectable_content:number_placeholders` | 1 |

## How to interpret

- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run.
- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0.
- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`.
