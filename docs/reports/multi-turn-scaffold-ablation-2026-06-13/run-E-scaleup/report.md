# Multi-turn scaffold ablation — 2026-06-13

**Models:** qwen2.5:0.5b, evomerge-qwen25-1b5:latest  
**Arms:** code, full  
**Seeds:** 0, 1, 2  
**Items per arm:** all 30  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 1014.2s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| qwen2.5:0.5b | c-code | 1/90 | 1.1% | [0.2, 6.0] | 1671 |
| evomerge-qwen25-1b5:latest | c-code | 6/90 | 6.7% | [3.1, 13.8] | 2287 |
| qwen2.5:0.5b | e-full | 0/90 | 0.0% | [0.0, 4.1] | 6523 |
| evomerge-qwen25-1b5:latest | e-full | 7/90 | 7.8% | [3.8, 15.2] | 12408 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| qwen2.5:0.5b | code | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |
| qwen2.5:0.5b | full | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen25-1b5:latest | code | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen25-1b5:latest | full | 0 | 0 | 0 | 0 | {"p":1,"b":0,"c":0,"n":0} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.