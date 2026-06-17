# Multi-turn scaffold ablation — 2026-06-17

**Models:** evomerge-t10-1b7-v7f:latest  
**Arms:** bare, param-only  
**Seeds:** 0, 1, 2  
**Items per arm:** all 30  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 258.2s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| evomerge-t10-1b7-v7f:latest | a-bare | 11/90 | 12.2% | [7.0, 20.6] | 1442 |
| evomerge-t10-1b7-v7f:latest | f-param-only | 37/90 | 41.1% | [31.5, 51.4] | 6100 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| evomerge-t10-1b7-v7f:latest | param-only | 29 | 3 | 8 | 50 | {"p":0.0000025560148060321838,"b":29,"c":3,"n":32} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.