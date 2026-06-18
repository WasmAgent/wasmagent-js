# local-offline — fully offline agent demo

A complete agentkit-js agent running with **no cloud calls** at all:

- **Model**: `@wasmagent/model-local` + `node-llama-cpp` (Qwen 3.5 0.8B by default)
- **Execution**: `@wasmagent/kernel-quickjs` — WASM sandbox, no Node.js APIs reachable
- **State**: in-memory `KvBackend` (the framework default)

After the first model download (~530 MB), you can disconnect from the network and re-run the demo — it still answers.

## Setup

```bash
# 1. Install the optional native peer (Node.js 20+, macOS/Linux/Windows pre-built binaries).
npm install node-llama-cpp

# 2. Pull the recommended model. Set AGENTKIT_MODEL_MIRROR if you're behind the GFW.
#    Options: huggingface (default), hf-mirror, modelscope, or any URL prefix.
npx agentkit model pull qwen3.5-0.8b
# Or with an explicit mirror:
AGENTKIT_MODEL_MIRROR=modelscope npx agentkit model pull qwen3.5-0.8b
```

## Run

```bash
# Default task: "Compute the sum of squares from 1 to 10 ..."
node index.mjs

# Or with a custom task:
node index.mjs "Reverse the string 'agentkit' and return the result."
```

## What you should see

```
[offline-demo] Loading model: qwen3.5-0.8b ...
[offline-demo] Model loaded.
[offline-demo] Task: Compute the sum of squares from 1 to 10 ...

[step 1] Thinking ...
  → execute_code({"code":"const r = Array.from({length:10},(_,i)=>(i+1)**2).reduce((a,b)=>a+b,0); return r;"})
  ← execute_code result: 385

[offline-demo] Final answer: 385
```

## Why a small model

Sub-1B models can be unreliable for **complex tool routing or deep multi-step reasoning** — that's a real limitation, not a software bug. Two compensations:

1. **Grammar-constrained sampling** — `LocalModel` enables JSON-Schema-grammar by default, so tool-call output is *structurally* legal 100% of the time. Semantic correctness still depends on the model.

2. **`localFirst` routing** — pair the local model with a cloud fallback for production workloads:

   ```js
   import { localFirst, LocalModel } from "@wasmagent/model-local";
   import { AnthropicModel } from "@wasmagent/core";
   const model = localFirst(
     new LocalModel({ source: { model: "qwen3.5-0.8b" } }),
     new AnthropicModel("claude-haiku-4-5-20251001", process.env.ANTHROPIC_API_KEY),
   );
   ```

   Local handles the easy cases; the cloud catches the rest. See the L5 routing presets in `@wasmagent/model-local`.

## Hardware notes

| Model | RAM @ load | First-token latency (Apple M-series, no GPU) |
|---|---|---|
| qwen3.5-0.8b q4_k_m | ~1.2 GB | ~150 ms |
| qwen3-0.6b q4_k_m | ~0.9 GB | ~120 ms |
| gemma-3-1b q4_k_m | ~1.5 GB | ~200 ms |

Throughput depends heavily on Metal/CUDA/Vulkan — `node-llama-cpp` auto-detects available accelerators.
