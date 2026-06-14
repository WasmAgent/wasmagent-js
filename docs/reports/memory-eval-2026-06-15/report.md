# Eval — 2026-06-14

**Suites:** locomo-refined, memory-agent-bench  
**Models:** qwen2.5:0.5b, evo-qwen3-1b7-q3km:latest, evomerge-t10-1b7-v3:latest  
**Seeds:** 0, 1, 2  
**Items per suite:** all  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 90.1s

## Per-(model, suite) accuracy

| model | suite | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| qwen2.5:0.5b | locomo-refined | 13/30 | 43.3% | [27.4, 60.8] | 496 |
| evo-qwen3-1b7-q3km:latest | locomo-refined | 15/30 | 50.0% | [33.2, 66.8] | 3710 |
| evomerge-t10-1b7-v3:latest | locomo-refined | 18/30 | 60.0% | [42.3, 75.4] | 273 |
| qwen2.5:0.5b | memory-agent-bench | 33/60 | 55.0% | [42.5, 66.9] | 171 |
| evo-qwen3-1b7-q3km:latest | memory-agent-bench | 48/60 | 80.0% | [68.2, 88.2] | 1409 |
| evomerge-t10-1b7-v3:latest | memory-agent-bench | 42/60 | 70.0% | [57.5, 80.1] | 302 |