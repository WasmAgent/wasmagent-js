# agentkit-js

**TypeScript agent runtime with WASM sandboxing, prompt-cache optimization, and parallel quality runners.**

Build production-grade AI agents in TypeScript — code-execution agents, tool-calling agents, or multi-path reasoning pipelines — with built-in cost controls and Cloudflare Workers deployment.

```bash
# For Anthropic (Claude)
pnpm add @agentkit-js/core @anthropic-ai/sdk

# For OpenAI / compatible endpoints (Ollama, vLLM, etc.)
pnpm add @agentkit-js/core openai
```

---

## Comparison

There are several mature TypeScript agent frameworks. Here is an honest assessment of where agentkit-js fits.

| | [Vercel AI SDK](https://github.com/vercel/ai) | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | [OpenAI Agents JS](https://github.com/openai/openai-agents-js) | [Mastra](https://github.com/mastra-ai/mastra) | [CF Agents SDK](https://github.com/cloudflare/agents) | **agentkit-js** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **npm downloads/month** | ~57M | ~10M | ~3.8M | ~4M | ~3.2M | early-stage |
| **ToolCallingAgent** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CodeAgent (sandboxed code exec)** | ❌ | ❌ | ❌ OS/Docker only | ❌ OS only | ⚠️ Worker isolation | ✅ WASM kernels |
| **Python execution (edge-safe)** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Pyodide-in-WASM |
| **Anthropic prompt-cache management** | ⚠️ pass-through | ⚠️ pass-through | ⚠️ via adapter | ⚠️ pass-through | ❌ | ✅ auto breakpoints |
| **Self-consistency / reflect-refine runners** | ❌ | ❌ manual | ❌ | ❌ | ❌ | ✅ built-in |
| **Budget forcing** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **DAG tool scheduler + speculative exec** | ❌ | ⚠️ graph-level | ❌ | ⚠️ workflow graph | ❌ | ✅ |
| **Long-history compaction** | ⚠️ syntactic prune | ❌ manual | ❌ | ⚠️ observational memory | ❌ | ✅ model-summarised |
| **MCP support** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cloudflare Workers** | ⚠️ partial | ✅ | ⚠️ experimental | ⚠️ alpha | ✅ native | ✅ |
| **UI hooks (React/Next.js)** | ✅ best-in-class | ❌ | ❌ | ⚠️ via AI SDK | ⚠️ | ✅ useAgentRun |
| **Provider integrations** | 40+ | 300+ | OpenAI-primary | 40+ | CF Workers AI | Anthropic + OpenAI-compat |
| **Evals framework** | ❌ | ⚠️ LangSmith | ❌ | ✅ 12+ scorers | ❌ | ✅ 4 built-in scorers |
| **Observability (OTel)** | ⚠️ LangSmith | ⚠️ LangSmith | ❌ | ✅ | ❌ | ✅ OtelBridge |
| **Retry / resilience** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ RetryPolicy |
| **Durable workflows / checkpointing** | ❌ | ✅ LangGraph | ❌ | ⚠️ partial | ✅ Durable Objects | ✅ Checkpointer |

### Where competitors are stronger

- **Vercel AI SDK** — If you're building a chat UI with Next.js, use this. The React hooks (`useChat`, `useAgent`) and 57M monthly downloads speak for themselves.
- **LangChain/LangGraph.js** — If you need 300+ integrations (vector stores, document loaders, obscure providers) or graph-based durable workflows with checkpointing and human-in-the-loop, LangGraph is battle-tested at LinkedIn, Uber, and GitLab scale.
- **Mastra** — Best eval framework (12+ built-in scorers including trajectory and tool accuracy). "Observational memory" (background LLM reflection on history) is genuinely novel. Strong developer onboarding.
- **Cloudflare Agents SDK** — If you're building on Cloudflare specifically, Durable Objects give you stateful agents with persistent scheduling that nothing else matches natively.
- **OpenAI Agents JS** — If your stack is OpenAI-only and you want first-party support, the cleanest path.

### Where agentkit-js is differentiated

- **WASM code kernels** — No other framework ships JsKernel, V8WasmKernel, PyodideKernel, or WasmtimeKernel. This enables in-process sandboxed code execution that works on edge/serverless without Docker or OS subprocess access.
- **Quality runners** — Self-consistency (majority vote), reflect-refine, budget forcing ("Wait" prefill), and parallel fork-join are not shipped as first-class APIs by any competitor.
- **Anthropic prompt-cache optimization** — Framework actively manages `cache_control` breakpoint placement across multi-turn history. Competitors pass through or validate limits but do not optimise placement.
- **Speculative tool execution** — Read-only, idempotent tools are pre-executed ahead of write barriers within a DAG step. No competitor implements this.

### Honest caveats

agentkit-js is early-stage. The differentiating features (WASM kernels, quality runners, speculative scheduling) are technically novel but also niche — most teams pick a framework based on ecosystem breadth and documentation volume, where the mature options above win. Choose agentkit-js when sandboxed code execution, prompt-cache cost control, or output quality runners are first-order concerns.

---

## Features

- **Two agent modes** — `CodeAgent` (writes + executes code) and `ToolCallingAgent` (native tool_use)
- **WASM sandboxing** — `JsKernel` enforces capability manifests; `PyodideKernel` runs CPython in WASM; `WasmtimeKernel` requires `@agentkit-js/kernel-wasmtime` + `javy`
- **Prompt-cache optimization** — `MessageAssembler` builds cache-stable prefixes; Anthropic `cache_control` breakpoints respect the 4-breakpoint limit and per-chunk token thresholds automatically
- **Quality runners** — majority-vote self-consistency, critique-refine cycles, "Wait" prefill budget forcing, parallel fork-join with synthesis
- **DAG scheduling** — independent tool calls execute concurrently via `Scheduler`; read-only tools speculatively pre-execute ahead of write barriers; wired into `ToolCallingAgent` by default
- **Long-history compaction** — `agent.assembler.compact(model, keepRecentSteps)` summarises old steps; inject a custom `MessageAssembler` via `assembler` option
- **Production resilience** — automatic exponential backoff + jitter retry for 429 / 5xx / network errors on all model adapters; configurable via `RetryPolicy`
- **Evals framework** — `runEval()` with built-in `exactMatch`, `toolCallAccuracy`, `trajectoryValidity`, `finalAnswerLength` scorers
- **Observability** — `OtelBridge` maps `AgentEvent` streams to OTel-compatible spans with token/cache usage attributes; injectable exporter
- **Checkpointing** — `InMemoryCheckpointer` (and interface for KV/Redis backends); `CheckpointableRun` saves state after each step; `await_human_input` pause events
- **React hooks** — `@agentkit-js/react` provides `useAgentRun()` for streaming SSE agent events in Next.js / React apps
- **Multi-model** — Anthropic (Claude) and OpenAI-compatible endpoints (Ollama, vLLM, llama.cpp)
- **MCP support** — `McpToolCollection` wraps any MCP server's tools as first-class agentkit tools
- **Cloudflare Workers** — HTTP API entry point with KV session caching, ready to deploy with Wrangler

---

## Quick Start

### Code Agent

```ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const agent = new CodeAgent({
  tools: [],
  model: new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4),
  maxSteps: 10,
});

for await (const event of agent.run("What is 42 * 1337?")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### Tool-Calling Agent

```ts
import { ToolCallingAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";
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
  model: new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4),
  maxSteps: 5,
});

for await (const event of agent.run("Search for recent AI news")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### CLI

```bash
# Install globally
npm install -g @agentkit-js/cli

# Run a task
agentkit run "What is the square root of 144?"

# Stream all events as NDJSON
agentkit run "Summarise recent AI news" --stream | jq .

# Use a specific model
agentkit run "Write a haiku" --model claude-opus-4-8 --max-steps 5
```

---

## Quality Runners

### Self-Consistency — majority vote across N independent runs

```ts
import { SelfConsistencyRunner, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const runner = new SelfConsistencyRunner({
  model: new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4),
  tools: [],
  n: 5,
  concurrency: 3,
  earlyStop: true,
});

const answer = await runner.run("What is the capital of France?");
```

### Reflect-Refine — critique loop until quality signal passes

```ts
import { ReflectRefineRunner, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const runner = new ReflectRefineRunner({
  model: new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4),
  tools: [],
  maxCycles: 3,
  qualitySignal: (answer) => answer.length > 100,
});

const answer = await runner.run("Write a detailed analysis of...");
```

### Parallel Fork-Join — diverse reasoning paths, synthesised answer

```ts
import { ParallelForkJoinRunner, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const runner = new ParallelForkJoinRunner({
  branches: 3,
  concurrency: 3,
  aggregation: "summary",
  branchPrompt: (i, msgs) => [
    ...msgs,
    { role: "user", content: `Analyse from perspective ${i + 1} of 3.` },
  ],
});

const result = await runner.run(
  new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4),
  [{ role: "user", content: "What are the trade-offs of microservices?" }]
);
console.log(result.answer);   // synthesised
console.log(result.branches); // individual paths
```

### Long-history compaction

```ts
import { CodeAgent, AnthropicModel, AnthropicModels, MessageAssembler } from "@agentkit-js/core";

const model = new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4);
const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new CodeAgent({
  tools: [],
  model,
  maxSteps: 50,
  assembler,
});

// Summarise old steps, keep context window in check
await agent.assembler.compact(model, 5);
```

---

## Custom Endpoints & Local Models

Both adapters accept an optional `baseURL` to point at any compatible endpoint — local models, third-party proxies, or private deployments.

### OpenAI-compatible (Ollama / vLLM / llama.cpp / any proxy)

```ts
import { OpenAIModel, OpenAIModels } from "@agentkit-js/core";

// Hosted OpenAI
const gpt4o = new OpenAIModel(OpenAIModels.GPT_4O);

// Local Ollama
const local = new OpenAIModel("mistral-7b", {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  samplingParams: { temperature: 0.7, seed: 42 },
});
```

### Anthropic-compatible proxy or private deployment

```ts
import { AnthropicModel, AnthropicModels } from "@agentkit-js/core";

// Standard usage — reads ANTHROPIC_API_KEY from environment
const model = new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4);

// Third-party proxy or private endpoint
const proxied = new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4, {
  apiKey: "your-proxy-key",
  baseURL: "https://your-proxy.example.com",
});
```

---

## Deploy to Cloudflare Workers

```bash
cd packages/cloudflare-worker
cp wrangler.toml.example wrangler.toml   # edit account_id and kv_namespaces
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

The Worker exposes a POST `/run` endpoint. Session state is stored in KV for cost-efficient prompt caching across requests.

---

## Packages

| Package | Description |
|---------|-------------|
| `@agentkit-js/core` | Agent runtime, kernels, models, tools, quality runners, evals, observability, checkpointing |
| `@agentkit-js/react` | `useAgentRun()` React hook for streaming SSE agent output |
| `@agentkit-js/cli` | `agentkit run` CLI |
| `@agentkit-js/kernel-pyodide` | CPython-in-WASM (Pyodide) |
| `@agentkit-js/kernel-quickjs` | QuickJS WASM kernel |
| `@agentkit-js/kernel-wasmtime` | True WASM sandbox via Javy + WASI (requires `javy` CLI) |
| `@agentkit-js/cloudflare-worker` | Cloudflare Workers HTTP entry point |

---

## Production APIs

### Retry / Resilience (C1)

All model adapters automatically retry 429 / 5xx / network errors with exponential backoff + jitter:

```ts
import { AnthropicModel } from "@agentkit-js/core";

const model = new AnthropicModel("claude-sonnet-4-6", {
  apiKey: process.env.ANTHROPIC_API_KEY,
  retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000 },
});
```

### Evals (B1)

```ts
import { runEval, exactMatch, toolCallAccuracy } from "@agentkit-js/core";

const results = await runEval(dataset, async function* (task) {
  yield* agent.run(task);
}, [exactMatch, toolCallAccuracy]);
```

### OpenTelemetry Bridge (C2)

```ts
import { OtelBridge, InMemorySpanExporter, withOtel } from "@agentkit-js/core";

const exporter = new InMemorySpanExporter(); // swap for OTLP in production
const bridge = new OtelBridge({ exporter });
for await (const ev of withOtel(agent.run(task), bridge)) {
  console.log(ev);
}
bridge.flush();
```

### Checkpointing / Durable Workflows (B4)

```ts
import { InMemoryCheckpointer, CheckpointableRun } from "@agentkit-js/core";

const checkpointer = new InMemoryCheckpointer();
const wrapper = new CheckpointableRun({ checkpointer }, agent.assembler);
for await (const ev of wrapper.run(agent.run(task), task, traceId)) {
  if (ev.event === "await_human_input") {
    // Pause and wait for human input…
    await checkpointer.respond(traceId, ev.data.promptId, "yes");
  }
}
```

### React Hook (B2)

```tsx
import { useAgentRun } from "@agentkit-js/react";

function ChatUI() {
  const { messages, isRunning, run } = useAgentRun("/api/run");
  return (
    <>
      {messages.map((m) => <div key={m.id}>{m.content}</div>)}
      <button onClick={() => run({ task: "What is 2 + 2?" })} disabled={isRunning}>
        Ask
      </button>
    </>
  );
}
```

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck

# Cloudflare Worker local dev
cd packages/cloudflare-worker && wrangler dev
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic model access |
| `OPENAI_API_KEY` | OpenAI / compatible endpoint |
| `CLOUDFLARE_API_TOKEN` | CI/CD Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` | CI/CD Worker deployment |

---

## Acknowledgements

Inspired by Hugging Face's [smolagents](https://github.com/huggingface/smolagents). agentkit-js is a ground-up TypeScript reimplementation — not a port — targeting async-first execution, WASM sandboxing, and edge deployment.

## License

Apache 2.0
