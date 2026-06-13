# Multi-turn scaffold ablation — 2026-06-13

**Models:** evo-qwen3-1b7-q3km:latest, evomerge-qwen3-v2:latest  
**Arms:** param-only  
**Seeds:** 0  
**Items per arm:** 6  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 514.7s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| evo-qwen3-1b7-q3km:latest | f-param-only | 3/6 | 50.0% | [18.8, 81.2] | 70108 |
| evomerge-qwen3-v2:latest | f-param-only | 4/6 | 66.7% | [30.0, 90.3] | 135431 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| evo-qwen3-1b7-q3km:latest | param-only | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen3-v2:latest | param-only | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.