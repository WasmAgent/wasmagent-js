# Multi-turn scaffold ablation — 2026-06-13

**Models:** qwen2.5:0.5b, evomerge-qwen25-1b5:latest  
**Arms:** code  
**Seeds:** 0  
**Items per arm:** 6  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 9.5s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| qwen2.5:0.5b | c-code | 0/6 | 0.0% | [0.0, 39.0] | 1150 |
| evomerge-qwen25-1b5:latest | c-code | 3/6 | 50.0% | [18.8, 81.2] | 1597 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| qwen2.5:0.5b | code | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen25-1b5:latest | code | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.