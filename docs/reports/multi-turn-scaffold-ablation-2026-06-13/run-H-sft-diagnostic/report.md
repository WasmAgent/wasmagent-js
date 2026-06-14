# Multi-turn scaffold ablation — 2026-06-14

**Models:** evo-qwen3-1b7-q3km:latest, evomerge-t10-1b7-v3:latest  
**Arms:** bare, param-only  
**Seeds:** 0, 1, 2  
**Items per arm:** all 30  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 3211.9s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| evo-qwen3-1b7-q3km:latest | a-bare | 0/90 | 0.0% | [0.0, 4.1] | 79 |
| evomerge-t10-1b7-v3:latest | a-bare | 0/90 | 0.0% | [0.0, 4.1] | 79 |
| evo-qwen3-1b7-q3km:latest | f-param-only | 36/90 | 40.0% | [30.5, 50.3] | 85457 |
| evomerge-t10-1b7-v3:latest | f-param-only | 17/90 | 18.9% | [12.1, 28.2] | 27871 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| evo-qwen3-1b7-q3km:latest | param-only | 36 | 0 | 0 | 54 | {"p":2.9103830456733717e-11,"b":36,"c":0,"n":36} |
| evomerge-t10-1b7-v3:latest | param-only | 17 | 0 | 0 | 73 | {"p":0.000015258789062500003,"b":17,"c":0,"n":17} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.