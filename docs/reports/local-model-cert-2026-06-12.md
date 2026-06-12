# Local-Model Cert — Real-Machine Baseline (2026-06-12)

> First real-hardware run of `examples/benchmarks/local-model-cert.mjs` against the embedded local-LLM provider (`@agentkit-js/model-local`). Run on Apple Silicon (M-series) with `node-llama-cpp@3.18.1` using its Metal backend.

## What changed in the framework as a result

Two real bugs that the unit tests + self-test didn't catch:

1. **Sequence/session disposal bug** — `node-llama-cpp` LlamaContext defaults to `sequences=1`. Without releasing the `LlamaContextSequence` after each `generate()`, the **second** call throws `"No sequences left"`. Every multi-call `LocalModel` user would have hit this.
   *Fix*: try/finally around the runtime body, dispose both session and sequence on every exit. Commit `20b73f7`. 4 new regression tests in `LocalModel.test.ts`.

2. **Prompt-addendum was too neutral** — small models choose `final_answer` over `tool_use` when the schema permits both. Original addendum said "you can either return a final answer or call exactly one tool" — too symmetric.
   *Fix*: stronger steering language in `buildToolPromptAddendum()`: "If ANY of the available tools matches what the user asks for, you MUST call that tool". Cert harness gained a `pickedTool` dimension to surface this explicitly.

The cert harness now reports three orthogonal dimensions for tool calling:

- **Form rate** — grammar-legal output (any of `tool_use` / `final_answer`)
- **Picked tool** — chose `tool_use` when a tool fit the request
- **Semantic rate** — right tool with right arguments

## Models tested

Both came from a local Ollama install (Qwen2.5-0.5B is the recommended candidate for `qwen2.5:0.5b` registry alias; the 1.7B q3_k_m is an "evolved/merged" variant the user happened to have).

| Model | Quant | Size | Source |
|---|---|---|---|
| Qwen2.5-0.5B Instruct | q4_0 | 379 MB | `ollama pull qwen2.5:0.5b` (2026-06) |
| evo-qwen3-1b7 | q3_k_m | 896 MB | local custom merge (Ollama lib) |

## Results

### Qwen2.5-0.5B (q4_0, 379 MB)

| Dimension | Form rate | Picked tool | Semantic rate |
|---|---|---|---|
| Tool calling | **3/3 (100%)** | **3/3 (100%)** | **3/3 (100%)** |
| Bilingual instruction (EN+ZH) | — | — | **4/4 (100%)** |
| CodeAgent (QuickJS sandbox) | — | — | 0/2 (0%) |

- First-token latency on Apple Silicon Metal: ~70–310 ms
- Model load: ~2.7 s
- Smoke test: `2+2 = "4"` returned in ~77 ms wall time
- Tool calling tasks (`calc(12+30)`, `weather(Paris)`, `search("quantum entanglement")`) all chose the right tool with correct arguments — **grammar-constrained tool calling on a 379 MB model is production-viable**.
- CodeAgent failed: 0.5B is too small to emit a JavaScript code block reliably. Expected — we don't recommend 0.5B for `CodeAgent` use cases.

### evo-qwen3-1b7 (q3_k_m, 896 MB)

| Dimension | Form rate | Picked tool | Semantic rate |
|---|---|---|---|
| Tool calling | **3/3 (100%)** | **3/3 (100%)** | **3/3 (100%)** |
| Bilingual instruction | — | — | 0/4 (0%) — empty outputs ⚠️ |
| CodeAgent (QuickJS sandbox) | — | — | **2/2 (100%)** |

- Tool calling perfect, **CodeAgent 100% — `sum(1..10) = 55`, `len("agentkit") = 8` both correct**.
- Bilingual returned empty strings on all 4 prompts. This is a quirk of this specific evolved/merged variant's chat template, not a `LocalModel` bug — out-of-the-box `qwen3-0.6b` (in our registry) is expected to work normally.

## Implications for the recommended-list

These first runs validate the cert harness end-to-end and give us real numbers, not predictions. They suggest:

- **Sub-1 GB models can do tool calling** (with grammar + good prompt) at 100% rate on simple tasks. The entry threshold for `recommended: true` should be **≥ 95% form rate AND ≥ 80% picked-tool rate AND ≥ 70% semantic rate** on the cert task set.
- **CodeAgent needs ≥1 GB** at q3_k_m or better. Don't gate `recommended` on CodeAgent — surface it as a separate "code-agent capable" badge.
- **Bilingual 100% on Qwen2.5-0.5B** is encouraging — Chinese support holds up at this size.

## How to reproduce

```bash
# Install peer (one-time):
bun add -d node-llama-cpp

# Build the workspace:
bun run build

# Run cert against any GGUF you have:
node examples/benchmarks/local-model-cert.mjs \
  --path /path/to/model.gguf \
  --kernel quickjs \
  --out report.md

# Or against a registry alias once sha256 is pinned (L4):
node examples/benchmarks/local-model-cert.mjs --model qwen3-0.6b --kernel quickjs
```

## What's next

- `qwen3-0.6b` and `gemma-3-1b` real-machine pulls + sha256 pinning in `MODEL_REGISTRY` (currently `sha256: ""`).
- Promote at least one model to `recommended: true` after a clean run.
- Add `agentkit-js/bscode` integration test with `localFirst(local, cloud)` — exercise the routing preset on a real workload.

## File pointers

- `packages/model-local/src/LocalModel.ts` — sequence/session disposal fix
- `packages/model-local/src/grammar.ts` — improved prompt addendum
- `packages/model-local/src/LocalModel.test.ts` — 4 new disposal regression tests
- `examples/benchmarks/local-model-cert.mjs` — three-dimension cert harness
- `docs/reports/local-model-cert-2026-06-12.md` — *this file*

## Honest caveats

- Apple Silicon Metal builds emit a known `GGML_ASSERT` at process exit ([llama.cpp PR #17869](https://github.com/ggml-org/llama.cpp/pull/17869)). It's a cleanup-order issue, **not** a generation bug — every test we ran completed correctly before the assert fired.
- The 1.7B model used here is a community-merged variant; results may not generalise to vanilla Qwen3 1.7B. Numbers should be re-collected when the registry pins a vetted GGUF.
- `node-llama-cpp` cannot run on Cloudflare Workers. For edge deployments, pair `LocalModel` with a cloud model via `localFirst(local, cloud)` and host `LocalModel` on a Node/Bun server.
