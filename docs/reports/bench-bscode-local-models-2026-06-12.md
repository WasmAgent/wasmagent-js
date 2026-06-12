# Local-Model Benchmark — bscode scenarios (real machine)

Apple Silicon Metal · `node-llama-cpp@3.18.x` · `@agentkit-js/model-local`

## Summary

| Model | Size | Load (ms) | Pass rate | Avg wall (ms) | Avg first-chunk (ms) | Avg t/s |
|---|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | 398 MB | 388 | 4/7 (57%) | 510 | 510 | 51 |
| evo-Qwen3-1.7B q3_k_m | 940 MB | 311 | 7/7 (100%) | 613 | 613 | 34 |
| evomerge-Qwen2.5-1.5B | 1647 MB | 388 | 7/7 (100%) | 559 | 559 | 33 |

## Per-scenario results

### S1-tool-pick-trivial — Trivial tool pick

> 1 obvious tool match

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✓ | 587 | 587 | 41 | `calc({"a":12,"b":30})` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 519 | 519 | 29 | `calc({"a":12,"b":30})` |
| evomerge-Qwen2.5-1.5B | ✓ | 521 | 521 | 29 | `calc({"a":12,"b":30})` |

### S2-tool-pick-among-4 — Pick among 4 tools

> Choose `list_files` from a 4-tool fleet

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✓ | 592 | 592 | 54 | `list_files({"path":"/workspace/src","pattern":""})` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 925 | 925 | 36 | `list_files({"path":"/workspace/src","pattern":"."})` |
| evomerge-Qwen2.5-1.5B | ✓ | 601 | 601 | 37 | `list_files({"path":"/workspace/src","pattern":".*"})` |

### S3-tool-pick-write — Pick `write_file` with content

> Multi-arg tool call with non-trivial string payload

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✗ | 317 | 317 | 63 | `read_file({"path":"/workspace/hello.js"})` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 655 | 655 | 44 | `write_file({"path":"/workspace/hello.js","content":"console.log(\"hello)` |
| evomerge-Qwen2.5-1.5B | ✓ | 697 | 697 | 42 | `write_file({"path":"/workspace/hello.js","content":"console.log(\"hello)` |

### S4-tool-pick-shell — Shell command construction

> Pick `run_command` and synthesise an actual shell invocation

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✗ | 567 | 567 | 51 | `list_files({"path":".","pattern":""})` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 514 | 514 | 35 | `run_command({"cmd":"git status"})` |
| evomerge-Qwen2.5-1.5B | ✓ | 530 | 530 | 34 | `run_command({"cmd":"git status"})` |

### S5-structured-json — Structured JSON output

> responseFormat = json_schema, no tools

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✓ | 360 | 360 | 47 | `{\n    "name": "Alice Chen",\n    "age": 32,\n    "city": "Shan` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 365 | 365 | 38 | `{"name": "Alice Chen", "age": 32, "city": "Shanghai"}` |
| evomerge-Qwen2.5-1.5B | ✓ | 571 | 571 | 30 | `{\n    "name": "Alice Chen",\n    "age": 32,\n    "city": "Shan` |

### S6-zh-tool-pick — Chinese tool pick

> 中文 prompt → English tool call

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✓ | 600 | 600 | 53 | `list_files({"path":"/workspace","pattern":""})` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 904 | 904 | 35 | `list_files({"path":"/workspace","pattern":"*"})` |
| evomerge-Qwen2.5-1.5B | ✓ | 573 | 573 | 37 | `list_files({"path":"/workspace","pattern":"*"})` |

### S7-no-tool-fits — No tool fits → final_answer

> Reject tool calls when nothing matches

| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |
|---|---|---|---|---|---|
| Qwen2.5-0.5B q4_0 | ✗ | 547 | 546 | 51 | `read_file({"path":"/path/to/french_capital"})` |
| evo-Qwen3-1.7B q3_k_m | ✓ | 412 | 412 | 24 | `Paris` |
| evomerge-Qwen2.5-1.5B | ✓ | 418 | 418 | 24 | `Paris` |

## Notes

- All models run with the same `LocalModel` config: `contextSize=4096`, `threads=4`, `temperature=0.2`.
- Grammar-constrained tool calling enabled (default). Single retry on token-budget truncation.
- `t/s` = output tokens / wall seconds. Approximate — usage tokens are estimated by the framework, not pulled from the engine.
- bscode tool shapes mirror the worker's actual tool fleet (file/read/write/run-command).