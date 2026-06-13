# Multi-turn scaffold ablation — 2026-06-13

**Models:** evo-qwen3-1b7-q3km:latest  
**Arms:** bare, param-only  
**Seeds:** 0, 1, 2  
**Items per arm:** all 30  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 2417.0s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| evo-qwen3-1b7-q3km:latest | a-bare | 0/90 | 0.0% | [0.0, 4.1] | 82 |
| evo-qwen3-1b7-q3km:latest | f-param-only | 29/90 | 32.2% | [23.5, 42.4] | 72326 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| evo-qwen3-1b7-q3km:latest | param-only | 29 | 0 | 0 | 61 | {"p":3.725290298461911e-9,"b":29,"c":0,"n":29} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.