# Multi-turn scaffold ablation — 2026-06-13

**Models:** qwen2.5:0.5b, evomerge-qwen25-1b5:latest  
**Arms:** bare, param-only, param-only-1pass  
**Seeds:** 0, 1, 2  
**Items per arm:** all 30  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 1257.5s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| qwen2.5:0.5b | a-bare | 11/90 | 12.2% | [7.0, 20.6] | 1432 |
| evomerge-qwen25-1b5:latest | a-bare | 0/90 | 0.0% | [0.0, 4.1] | 82 |
| qwen2.5:0.5b | f-param-only | 13/90 | 14.4% | [8.6, 23.2] | 5079 |
| evomerge-qwen25-1b5:latest | f-param-only | 22/90 | 24.4% | [16.7, 34.2] | 18593 |
| qwen2.5:0.5b | f-param-only-1pass | 11/90 | 12.2% | [7.0, 20.6] | 3796 |
| evomerge-qwen25-1b5:latest | f-param-only-1pass | 7/90 | 7.8% | [3.8, 15.2] | 5627 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| qwen2.5:0.5b | param-only | 4 | 2 | 9 | 75 | {"p":0.6875000000000002,"b":4,"c":2,"n":6} |
| qwen2.5:0.5b | param-only-1pass | 5 | 5 | 6 | 74 | {"p":1,"b":5,"c":5,"n":10} |
| evomerge-qwen25-1b5:latest | param-only | 22 | 0 | 0 | 68 | {"p":4.7683715820312495e-7,"b":22,"c":0,"n":22} |
| evomerge-qwen25-1b5:latest | param-only-1pass | 7 | 0 | 0 | 83 | {"p":0.015625000000000003,"b":7,"c":0,"n":7} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.