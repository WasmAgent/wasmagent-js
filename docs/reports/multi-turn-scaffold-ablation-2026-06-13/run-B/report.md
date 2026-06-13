# Multi-turn scaffold ablation — 2026-06-13

**Models:** qwen2.5:0.5b, evomerge-qwen25-1b5:latest  
**Arms:** bare, grammar, code, self-consist, full  
**Seeds:** 0  
**Items per arm:** 6  
**Endpoint:** `http://localhost:11434/v1`  
**Total wall:** 368.9s

## Per-(model, arm) accuracy

| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |
|---|---|---:|---:|---:|---:|
| qwen2.5:0.5b | a-bare | 1/6 | 16.7% | [3.0, 56.4] | 2060 |
| evomerge-qwen25-1b5:latest | a-bare | 0/6 | 0.0% | [0.0, 39.0] | 1293 |
| qwen2.5:0.5b | b-grammar | 2/6 | 33.3% | [9.7, 70.0] | 1751 |
| evomerge-qwen25-1b5:latest | b-grammar | 0/6 | 0.0% | [0.0, 39.0] | 95 |
| qwen2.5:0.5b | c-code | 1/6 | 16.7% | [3.0, 56.4] | 5747 |
| evomerge-qwen25-1b5:latest | c-code | 0/6 | 0.0% | [0.0, 39.0] | 13893 |
| qwen2.5:0.5b | d-self-consist | 1/6 | 16.7% | [3.0, 56.4] | 4616 |
| evomerge-qwen25-1b5:latest | d-self-consist | 0/6 | 0.0% | [0.0, 39.0] | 500 |
| qwen2.5:0.5b | e-full | 0/6 | 0.0% | [0.0, 39.0] | 22030 |
| evomerge-qwen25-1b5:latest | e-full | 1/6 | 16.7% | [3.0, 56.4] | 52299 |

## McNemar exact (each arm vs bare)

| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |
|---|---|---:|---:|---:|---:|---:|
| qwen2.5:0.5b | grammar | 1 | 0 | 1 | 4 | {"p":1,"b":1,"c":0,"n":1} |
| qwen2.5:0.5b | code | 0 | 0 | 1 | 5 | {"p":1,"b":0,"c":0,"n":0} |
| qwen2.5:0.5b | self-consist | 0 | 0 | 1 | 5 | {"p":1,"b":0,"c":0,"n":0} |
| qwen2.5:0.5b | full | 0 | 1 | 0 | 5 | {"p":1,"b":0,"c":1,"n":1} |
| evomerge-qwen25-1b5:latest | grammar | 0 | 0 | 0 | 6 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen25-1b5:latest | code | 0 | 0 | 0 | 6 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen25-1b5:latest | self-consist | 0 | 0 | 0 | 6 | {"p":1,"b":0,"c":0,"n":0} |
| evomerge-qwen25-1b5:latest | full | 1 | 0 | 0 | 5 | {"p":1,"b":1,"c":0,"n":1} |

## Reading the report

- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).
- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.
- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.
- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.