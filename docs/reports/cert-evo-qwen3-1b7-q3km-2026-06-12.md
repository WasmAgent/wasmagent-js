# Local-Model Cert Report: /Users/I041705/.ollama/models/blobs/sha256-e0e684fc428b5c89fd5e8096f0d4db4b3125ca622552d7571e9da1eca3730e28

Mode: real-model run (grammar=on)

## Summary

| Dimension | Form rate | Picked tool | Semantic rate |
|---|---|---|---|
| Tool calling | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |
| Bilingual instruction | — | — | 0/4 (0.0%) |
| CodeAgent | — | — | 2/2 (100.0%) |

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

- **en1** — output: 
- **en2** — output: 
- **zh1** — output: 
- **zh2** — output: 

## CodeAgent — failures

(none)
