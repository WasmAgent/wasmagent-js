# agentkit-js

> TypeScript + WASM agent runtime — a high-efficiency reimagination of [smolagents](https://github.com/huggingface/smolagents) by Hugging Face.

## Acknowledgements

This project draws significant inspiration from Hugging Face's [smolagents](https://github.com/huggingface/smolagents) (Python). The core agent loop structure, tool abstraction design (`Tool.forward()` / `ToolCollection`), step-type semantics (`ActionStep` / `PlanningStep` / `FinalAnswerStep`), and overall "few lines to a working agent" developer experience are all informed by smolagents' excellent design.

`agentkit-js` is a ground-up TypeScript reimplementation targeting different runtime characteristics — not a port. Key differences:

| | smolagents (Python) | agentkit-js |
|---|---|---|
| Execution | Sync serial `while` loop, 0 `async def` | `async/await` + `AsyncGenerator` |
| Sandbox | Blacklist AST interpreter (`local_python_executor.py`) | WASM capability model (deny-all, A2) |
| Context | Full history rebuilt every step (O(n²) tokens) | Cache-friendly prefix assembly (B1/B2) |
| Caching | Zero `cache_control` | Anthropic prompt-caching breakpoints (B1) |
| Language | Python | TypeScript (JS + Pyodide/CPython kernels; MicroPython planned) |
| Agents | `CodeAgent`, `ToolCallingAgent` | `CodeAgent`, `ToolCallingAgent` |
| Scheduling | Serial | DAG + speculative execution (C2/C3) |
| Quality | Single pass | Self-consistency, reflect-refine, budget forcing, parallel fork-join (P2/P3/S4/L4) |
| History | Unbounded | `MessageAssembler.compact()` — model-summarised long history (P4) |

## Quick Start

```bash
pnpm add @agentkit-js/core @anthropic-ai/sdk
```

```ts
import { CodeAgent, AnthropicModel } from "@agentkit-js/core";

const agent = new CodeAgent({
  tools: [],
  model: new AnthropicModel("claude-sonnet-4-6"),
  maxSteps: 10,
});

for await (const event of agent.run("What is 42 * 1337?")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### ToolCallingAgent

```ts
import { ToolCallingAgent, AnthropicModel } from "@agentkit-js/core";
import { z } from "zod";

const searchTool = {
  name: "search",
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ query }) => `Results for: ${query}`,
};

const agent = new ToolCallingAgent({
  tools: [searchTool],
  model: new AnthropicModel("claude-sonnet-4-6"),
  maxSteps: 5,
});

for await (const event of agent.run("Search for recent AI news")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### Self-Consistency (majority-vote quality)

```ts
import { SelfConsistencyRunner, AnthropicModel } from "@agentkit-js/core";

const runner = new SelfConsistencyRunner({
  model: new AnthropicModel("claude-sonnet-4-6"),
  tools: [],
  n: 5,           // run up to 5 candidates
  concurrency: 3, // max 3 in parallel
  earlyStop: true, // stop when majority threshold is reached
});

const answer = await runner.run("What is the capital of France?");
console.log(answer);
```

### Reflect-Refine (critique loop)

```ts
import { ReflectRefineRunner, AnthropicModel } from "@agentkit-js/core";

const runner = new ReflectRefineRunner({
  model: new AnthropicModel("claude-sonnet-4-6"),
  tools: [],
  maxCycles: 3,
  qualitySignal: (answer) => answer.length > 100, // custom signal
});

const answer = await runner.run("Write a detailed analysis of...");
console.log(answer);
```

### Parallel Fork-Join (diversity reasoning)

```ts
import { ParallelForkJoinRunner, AnthropicModel } from "@agentkit-js/core";

const runner = new ParallelForkJoinRunner({
  branches: 3,           // fork into 3 independent reasoning paths
  concurrency: 3,        // all 3 run in parallel
  aggregation: "summary", // synthesise into one final answer
  // Optional: inject a different angle for each branch
  branchPrompt: (i, msgs) => [
    ...msgs,
    { role: "user", content: `Analyse from perspective ${i + 1} of 3.` },
  ],
});

const result = await runner.run(
  new AnthropicModel("claude-sonnet-4-6"),
  [{ role: "user", content: "What are the trade-offs of microservices?" }]
);
console.log(result.answer);        // synthesised final answer
console.log(result.branches);      // individual branch answers
```

```ts
import { OpenAIModel } from "@agentkit-js/core";

const model = new OpenAIModel("mistral-7b", {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  samplingParams: { temperature: 0.7, seed: 42 },
});
```

### Long-history compaction

```ts
import { CodeAgent, AnthropicModel, MessageAssembler } from "@agentkit-js/core";

const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new CodeAgent({
  tools: [],
  model: new AnthropicModel("claude-sonnet-4-6"),
  maxSteps: 50,
  assembler,
});

// After many steps, compact old history into a model-written summary
await assembler.compact(agent.model, { keepRecentSteps: 5 });
```

## Architecture

```
agentkit-js/
├── packages/
│   ├── core/                 # Agent runtime, executor, memory, models, tools, enhancement
│   ├── cli/                  # agentkit CLI
│   ├── kernel-pyodide/       # CPython-in-WASM kernel (Pyodide)
│   ├── kernel-quickjs/       # QuickJS WASM kernel
│   ├── model-anthropic/      # Re-export of core AnthropicModel
│   ├── model-openai/         # Re-export of core OpenAIModel
│   └── cloudflare-worker/    # Cloudflare Workers HTTP API entry point
└── examples/
    └── basic-agent/          # Minimal working example
```

### Design pillars

- **A — Persistent WASM execution kernel** — `JsKernel` (default) runs JS in a Node.js vm sandbox with capability enforcement (deny-all, per-call `allowedHosts`/`allowedReadPaths`/`allowedWritePaths`). `V8WasmKernel` is the serverless-safe fallback; `createKernel()` auto-selects based on runtime. `PyodideKernel` runs CPython in WASM.
- **B — Context engineering** — `MessageAssembler` builds cache-stable message prefixes (B1) with configurable history segment caching (B2 `chunkSizeSteps`) and `compact()` for long-run history summarisation (P4).
- **C — DAG scheduling + async core** — `AsyncGenerator`-based streaming with structured `AgentEvent` objects carrying `traceId`/`parentTraceId`. `Scheduler` executes tool DAGs in parallel (C2) with speculative pre-execution of read-only nodes ahead of barriers (C3).
- **D — Developer ergonomics** — `CodeAgent` and `ToolCallingAgent` constructors mirror smolagents', enabling incremental migration. Tools declare `readOnly`/`idempotent`/`requiredCapability` for scheduling and access control. `EnhancementPolicy` wires quality runners per-agent.
- **P — Output quality runners** — `SelfConsistencyRunner` (adaptive N, majority vote, concurrency cap), `ReflectRefineRunner` (critique-refine cycles, context isolation), `BudgetForcingRunner` ("Wait" prefill injection for deeper reasoning), `ParallelForkJoinRunner` (N parallel branches with branchPrompt diversity, summary/first/fn join). All are budget-gated and composable.

### Implementation status

| Pillar | Feature | Status |
|--------|---------|--------|
| A1 | `JsKernel` — stateful JS sandbox, snapshot/restore | ✅ Done |
| A1 | `V8WasmKernel` — serverless-safe fallback | ✅ Done |
| A1 | `WasmtimeKernel` — native WASM binding | ⏳ Remaining (requires native addon) |
| A2 | Capability manifest enforcement (hosts, paths, SSRF-safe redirect) | ✅ Done |
| A2 | `extraCapabilities` per-tool access control | ✅ Done |
| A4 | `PyodideKernel` — CPython-in-WASM via `pyodide` npm package | ✅ Done |
| B1 | `MessageAssembler` cache-stable prefix | ✅ Done |
| B1 | `AnthropicModel` `cache_control` breakpoints with token threshold | ✅ Done |
| B2 | Segment caching (`chunkSizeSteps`) | ✅ Done |
| B3 | `LazyObservationHandle` — async tool result handles | ✅ Done |
| C1 | `AsyncGenerator` streaming with `traceId`/`parentTraceId` | ✅ Done |
| C2 | DAG scheduling — parallel independent nodes | ✅ Done |
| C3 | Speculative execution — read-only nodes ahead of barriers | ✅ Done |
| C4 | Session/KV caching (Cloudflare Worker + KV namespace) | ✅ Done |
| D1 | `actionLanguage` routing (js/pyodide; micropython planned) | ✅ Done (js+pyodide) |
| D2 | Typed tools with Zod schemas, `readOnly`/`idempotent` enforcement | ✅ Done |
| D2 | `zodToJsonSchema` — full Zod→JSON Schema converter | ✅ Done |
| D4 | `McpToolCollection` — MCP server tools as agentkit ToolDefinitions | ✅ Done |
| D5 | `CodeAgent` — code-execution agent | ✅ Done |
| D5 | `ToolCallingAgent` — native tool_use agent | ✅ Done |
| D6 | `agentkit run` CLI with `--stream`/`--events` | ✅ Done |
| D6 | `agentkit init-tool` scaffold | ✅ Done |
| E1 | `AnthropicModel` — streaming + tool_use + cache | ✅ Done |
| E1 | `OpenAIModel` — streaming + tool_call | ✅ Done |
| E1-edge | `createKernel` edge-runtime detection — auto-select V8WasmKernel when `worker_threads` absent | ✅ Done |
| O1 | `OpenAIModel` `baseURL` + `defaultHeaders` — local model support (Ollama/vLLM/llama.cpp) | ✅ Done |
| O2 | Sampling params end-to-end (`temperature`/`topP`/`seed`/`stopSequences`) — both adapters | ✅ Done |
| O3 | `ModelCapabilities` descriptor (`localEndpoint`/`metered`/`supportsGrammar`/`supportsBudgetForcing`/`contextWindow`) | ✅ Done |
| P0 | `TokenBudget` + `estimateMessagesTokens()` fallback when backend omits usage events | ✅ Done |
| P1 | `EnhancementPolicy` + `ResourceBudget` config — adaptive defaults, wired into both agents | ✅ Done |
| P2 | `SelfConsistencyRunner` — adaptive N, early-stop majority vote, concurrency cap | ✅ Done |
| P3 | `ReflectRefineRunner` — signal-triggered, context-isolated, budget-gated | ✅ Done |
| P4 | `MessageAssembler.compact()` — cache-aware model-summarised long history | ✅ Done |
| S1 | Structured output constraints (`responseFormat` — `json_schema`, capability-gated) | ✅ Done |
| S2 | Parse-failure self-healing — retry with format correction (`extractCode` null guard) | ✅ Done |
| S3 | Cache determinism hardening — `toJsonSchema()` sorted, tools `cache_control` at last item | ✅ Done |
| S4 | `BudgetForcingRunner` — "Wait" prefill injection, `maxWaitRounds`, `minResponseTokens` | ✅ Done |
| U1 | `channel:"status"` events — `tool_executing` phase during tool dispatch | ✅ Done |
| L4 | `ParallelForkJoinRunner` — shared-prefix parallel branches, configurable aggregation (summary/first/fn) | ✅ Done |
| **A1** | **`WasmtimeKernel` — native WASM binding** (requires JS→WASM transpiler, e.g. Javy; not a drop-in npm install) | **⏳ Remaining** |
| **D1** | **MicroPython execution backend** — dropped; no reliable ESM npm package exposes a Python exec() API; use `"pyodide"` instead | **⛔ Dropped** |

### Roadmap

| Milestone | Scope |
|-----------|-------|
| **M0** ✅ | `JsKernel`, `CodeAgent`, `MessageAssembler`, Cloudflare Worker |
| **M1** ✅ | `V8WasmKernel`, A2 capability enforcement, C1 streaming, D2 typed tools |
| **M2** ✅ | C2 DAG scheduling, C3 speculative execution, B2 segment caching, E1 model adapters |
| **M3** ✅ | `PyodideKernel` (A4), `LazyObservationHandle` (B3), `McpToolCollection` (D4), `init-tool` (D6), C4 session KV |
| **M4** ✅ | O1+O2 (baseURL + sampling params); S2+S3 (parse self-heal + cache hardening); E1-edge kernel auto-select |
| **M5** ✅ | O3 (ModelCapabilities); S1+S4 (structured output + budget forcing); P0+P1 (policy skeleton) |
| **M6** ✅ | P2+P3+U1 (self-consistency + critique-refine + status events) |
| **M7** ✅ | P4 long-history compaction (`MessageAssembler.compact`) |
| **Future (done)** ✅ | L4 `ParallelForkJoinRunner` — shared-prefix parallel branches + synthesis |
| **Future** | WasmtimeKernel native addon (requires Javy/WASM transpiler); MicroPython dropped (no reliable ESM package) |

> Status legend: ✅ Done · ⏳ Planned · ⛔ Dropped

## Development

```bash
# Install
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Typecheck
pnpm typecheck

# Cloudflare Worker local dev
cd packages/cloudflare-worker && wrangler dev
```

### CLI

```bash
# Run a task
agentkit run "What is the square root of 144?"

# Stream all events as NDJSON
agentkit run "Summarise recent AI news" --stream | jq .

# Filter to specific event types
agentkit run "Calculate something" --events final_answer,error

# Use a different model
agentkit run "Write a haiku" --model claude-opus-4-8 --max-steps 5
```

### Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `ANTHROPIC_API_KEY` | `.env` / Wrangler secret | Anthropic model API access |
| `OPENAI_API_KEY` | `.env` | OpenAI / compatible endpoint API access |
| `CLOUDFLARE_API_TOKEN` | GitHub secret | CI/CD Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub secret | CI/CD Worker deployment |

## License

Apache 2.0
