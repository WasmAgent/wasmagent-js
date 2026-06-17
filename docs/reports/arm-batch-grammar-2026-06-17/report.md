# Multi-turn scaffold ablation — 2026-06-17

**Models:** evomerge-t10-1b7-v7f:latest  
**Arms:** bare, param-only, batch-grammar  
**Seeds:** 0, 1, 2  
**Items per arm:** all 30  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 300.2s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| evomerge-t10-1b7-v7f:latest | a-bare | 6/90 | 6.7% | [3.1, 13.8] | 1418 |
| evomerge-t10-1b7-v7f:latest | f-param-only | 35/90 | 38.9% | [29.5, 49.2] | 6224 |
| evomerge-t10-1b7-v7f:latest | g-batch-grammar | 13/90 | 14.4% | [8.6, 23.2] | 1281 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| evomerge-t10-1b7-v7f:latest | param-only | 29 | 0 | 6 | 55 | {"p":3.725290298461911e-9,"b":29,"c":0,"n":29} |
| evomerge-t10-1b7-v7f:latest | batch-grammar | 7 | 0 | 6 | 77 | {"p":0.015625000000000003,"b":7,"c":0,"n":7} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.