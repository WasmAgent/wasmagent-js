# Local-Model Cert Report: /Users/I041705/.ollama/models/blobs/sha256-c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515

Mode: real-model run (grammar=on)

## Summary

| Dimension | Form rate | Picked tool | Semantic rate |
|---|---|---|---|
| Tool calling | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |
| Bilingual instruction | — | — | 4/4 (100.0%) |
| CodeAgent | — | — | 0/2 (0.0%) |

**Form rate** = grammar-legal output (any of `tool_use` / `final_answer`).  
**Picked tool** = chose `tool_use` when a tool fit the request (vs falling back to `final_answer`).  
**Semantic rate** = picked the right tool with the right arguments.

## Tool calling — per-task

| id | form | tool | semantic | detail |
|---|---|---|---|---|
| tc1 | ✓ | ✓ | ✓ |  |
| tc2 | ✓ | ✓ | ✓ |  |
| tc3 | ✓ | ✓ | ✓ |  |

## Bilingual — failures

(none)

## CodeAgent — failures

- **ca1** — final: 
- **ca2** — final: 
