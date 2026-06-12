# Evaluation Report

> **Started:** 2026-06-12T05:15:44.430Z
> **Wall:** 57.5 s · **Models:** 5 · **Suites:** 1 · **Seeds:** 1 (0)

## Summary

| Suite | Model | Mean acc | 95% Wilson | σ across seeds | Tokens | Cost (USD) | p95 wall (ms) | Pareto |
|---|---|---:|:-:|---:|---:|---:|---:|:-:|
| `multi-turn-memory` | `qwen2.5:0.5b` | **66.7%** | [30.0%, 90.3%] | 0.00pp | 1,130 | $0.0000 | 1,038 | ★ |
| `multi-turn-memory` | `evo-qwen3-1b7-q3km:latest` | **100.0%** | [61.0%, 100.0%] | 0.00pp | 1,903 | $0.0000 | 4,009 | ★ |
| `multi-turn-memory` | `evomerge-qwen25-1b5:latest` | **66.7%** | [30.0%, 90.3%] | 0.00pp | 1,150 | $0.0000 | 1,635 |  |
| `multi-turn-memory` | `evomerge-qwen3-v2:latest` | **100.0%** | [61.0%, 100.0%] | 0.00pp | 2,192 | $0.0000 | 16,492 |  |
| `multi-turn-memory` | `gemma4-12b:latest` | **100.0%** | [61.0%, 100.0%] | 0.00pp | 1,741 | $0.0000 | 16,510 |  |

### Pareto front

A model is on the Pareto front for a suite if no other model has **at least its accuracy AND lower-or-equal cost AND lower-or-equal p95 wall**, with at least one strict win. ★ = on the front.

## Suite `multi-turn-memory` — Multi-turn memory recall (LongMemEval-style, 6 items)

> Conversation-history recall across 5 categories. Each item is a 4–28 turn dialog ending with a question; the model must answer using facts from earlier turns. Mirrors the bundled longmemeval.mjs fixture.

| Model | S1 | S2 | S3 | S4 | S5 | S6 | All-seed acc |
|---|---|---|---|---|---|---|---|
| `qwen2.5:0.5b` | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | 66.7% |
| `evo-qwen3-1b7-q3km:latest` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 100.0% |
| `evomerge-qwen25-1b5:latest` | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | 66.7% |
| `evomerge-qwen3-v2:latest` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 100.0% |
| `gemma4-12b:latest` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 100.0% |

## Configuration

| Model | Base URL | model id | Temp | $/M in | $/M out |
|---|---|---|---:|---:|---:|
| `qwen2.5:0.5b` | `http://localhost:11434/v1` | `qwen2.5:0.5b` | 0 | $0.00 | $0.00 |
| `evo-qwen3-1b7-q3km:latest` | `http://localhost:11434/v1` | `evo-qwen3-1b7-q3km:latest` | 0 | $0.00 | $0.00 |
| `evomerge-qwen25-1b5:latest` | `http://localhost:11434/v1` | `evomerge-qwen25-1b5:latest` | 0 | $0.00 | $0.00 |
| `evomerge-qwen3-v2:latest` | `http://localhost:11434/v1` | `evomerge-qwen3-v2:latest` | 0 | $0.00 | $0.00 |
| `gemma4-12b:latest` | `http://localhost:11434/v1` | `gemma4-12b:latest` | 0 | $0.00 | $0.00 |
