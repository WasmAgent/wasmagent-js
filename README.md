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
| **CodeAgent (sandboxed code exec)** | ❌ | ❌ | ❌ OS/Docker only | ❌ OS only | ⚠️ Worker isolation | ✅ 3-tier: in-process / true WASM / microVM |
| **Python execution (edge-safe)** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Pyodide-in-WASM |
| **Anthropic prompt-cache management** | ⚠️ pass-through | ⚠️ pass-through | ⚠️ via adapter | ⚠️ pass-through | ❌ | ✅ auto breakpoints + 1h TTL |
| **Self-consistency / reflect-refine runners** | ❌ | ❌ manual | ❌ | ❌ | ❌ | ✅ built-in |
| **Budget forcing** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **DAG tool scheduler + speculative exec** | ❌ | ⚠️ graph-level | ❌ | ⚠️ workflow graph | ❌ | ✅ |
| **Long-history compaction** | ⚠️ syntactic prune | ❌ manual | ❌ | ⚠️ observational memory | ❌ | ✅ model-summarised |
| **MCP support** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cloudflare Workers** | ⚠️ partial | ✅ | ⚠️ experimental | ⚠️ alpha | ✅ native | ✅ |
| **UI hooks (React/Next.js)** | ✅ best-in-class | ❌ | ❌ | ⚠️ via AI SDK | ⚠️ | ✅ useAgentRun |
| **Provider integrations** | 40+ | 300+ | OpenAI-primary | 40+ | CF Workers AI | Anthropic + OpenAI-compat |
| **Evals framework** | ❌ | ⚠️ LangSmith | ❌ | ✅ 12+ scorers | ❌ | ✅ 4 built-in scorers |
| **Observability (OTel)** | ⚠️ LangSmith | ⚠️ LangSmith | ❌ | ✅ | ❌ | ✅ OtelBridge + GenAI semconv |
| **Retry / resilience** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ RetryPolicy |
| **Durable workflows / checkpointing** | ✅ DurableAgent (AI SDK 6) | ✅ LangGraph | ❌ (Assistants API retiring 2026-08-26) | ⚠️ partial | ✅ Durable Objects | ✅ Checkpointer |

### Where competitors are stronger

- **Vercel AI SDK** — If you're building a chat UI with Next.js, use this. The React hooks (`useChat`, `useAgent`), `DurableAgent` for stateful/resumable workflows (AI SDK 6), native MCP support, and DevTools panel are all best-in-class. 57M monthly downloads.
- **LangChain/LangGraph.js** — If you need 300+ integrations (vector stores, document loaders, obscure providers) or graph-based durable workflows with checkpointing and human-in-the-loop, LangGraph is battle-tested at LinkedIn, Uber, and GitLab scale.
- **Mastra** — Best eval framework (12+ built-in scorers including trajectory and tool accuracy). "Observational memory" (background LLM reflection on history) is genuinely novel. Strong developer onboarding.
- **Cloudflare Agents SDK** — If you're building on Cloudflare specifically, Durable Objects give you stateful agents with persistent scheduling that nothing else matches natively.
- **OpenAI Agents JS** — If your stack is OpenAI-only and you want first-party support, the cleanest path.

### Where agentkit-js is differentiated

- **Code execution kernels — three isolation tiers**: `VmKernel` (in-process node:vm, dev/low-trust), true WASM kernels (`@agentkit-js/kernel-quickjs`, `kernel-pyodide`, `kernel-wasmtime` — language-level isolation, edge-safe), and external microVM via `RemoteSandboxKernel` (E2B / Cloudflare Sandbox, full process isolation). No other framework ships all three tiers as a composable interface.
- **Quality runners** — Self-consistency with answer extraction (boxed / last-line / custom), reflect-refine, budget forcing ("Wait" prefill), and parallel fork-join are not shipped as first-class APIs by any competitor.
- **Anthropic prompt-cache optimization** — Framework actively manages `cache_control` breakpoint placement across multi-turn history, supports the 1-hour extended TTL (`ttl:"1h"`), and reports per-TTL cache usage. Competitors pass through or validate limits but do not optimise placement.
- **Speculative tool execution** — Read-only, idempotent tools are pre-executed ahead of write barriers within a DAG step. The scheduler is awakened by `$<callId>` dependency references in the system prompt, enabling true parallel + ordered hybrid scheduling. No competitor implements this.
- **GenAI semantic conventions** — `OtelBridge` emits standard `gen_ai.*` attributes (Datadog / Honeycomb / Grafana GenAI view compatible) alongside legacy names, switchable via `semconvMode`.

### Honest caveats

agentkit-js is early-stage. The differentiating features (code execution kernels, quality runners, speculative scheduling) are technically novel but also niche — most teams pick a framework based on ecosystem breadth and documentation volume, where the mature options above win. Choose agentkit-js when sandboxed code execution, prompt-cache cost control, or output quality runners are first-order concerns.

---

## Features

- **Two agent modes** — `CodeAgent` (writes + executes code) and `ToolCallingAgent` (native tool_use)
- **Code execution — three isolation tiers** — `VmKernel` (node:vm, in-process dev/test), `QuickJSKernel` / `PyodideKernel` / `WasmtimeKernel` (true WASM, language-level isolation, edge-safe), `RemoteSandboxKernel` (E2B / Cloudflare Sandbox microVM, full process isolation). Mix tiers via `factory.createKernel()`.
- **Programmatic Tool Calling (PTC)** — `ProgrammaticOrchestrator` executes model-generated scripts inside any kernel; `callTool()` calls registered tools without surfacing intermediate results to the context (−37% tokens). Self-hosted alternative to Anthropic's managed PTC container.
- **Prompt-cache optimization** — `MessageAssembler` builds cache-stable prefixes; Anthropic `cache_control` breakpoints respect the 4-breakpoint limit, per-chunk token thresholds, and the 1-hour extended TTL (`ttl:"1h"`); per-TTL usage metering (5m vs 1h); OpenAI automatic prefix cache hit tracking
- **Tool deferred loading** — `deferLoading: true` on any tool (or `McpToolCollection.deferAll()`) excludes its schema from the system prefix and loads on-demand via Anthropic Tool Search (−85% tokens for large MCP server collections)
- **Tool Use Examples** — `inputExamples` on any tool maps to Anthropic's `input_examples` wire field (72%→90% parameter accuracy)
- **Context editing** — `assembler.editToolResults({ maxTokens, keepRecent })` truncates old tool outputs reversibly without breaking conversation structure (+29% task performance, −84% tokens on web search)
- **Cross-session Memory Tool** — `createMemoryTool({ backend })` gives agents persistent read/write/list/delete memory backed by any `KvBackend` (Cloudflare KV, Redis, in-memory Map)
- **Quality runners** — majority-vote self-consistency with answer extraction (boxed / last-line / custom hook), critique-refine cycles, "Wait" prefill budget forcing, parallel fork-join with synthesis
- **DAG scheduling** — independent tool calls execute concurrently via `Scheduler`; read-only tools speculatively pre-execute ahead of write barriers; `$<callId>` dependency syntax in system prompt enables true data-dependency ordering; wired into `ToolCallingAgent` by default
- **Long-history compaction** — `agent.assembler.compact(model, keepRecentSteps)` summarises old steps; inject a custom `MessageAssembler` via `assembler` option
- **Production resilience** — automatic exponential backoff + jitter retry for 429 / 5xx / network errors on all model adapters; configurable via `RetryPolicy`
- **Evals framework** — `runEval()` with built-in `exactMatch`, `toolCallAccuracy`, `trajectoryValidity`, `finalAnswerLength` scorers
- **Observability** — `OtelBridge` maps `AgentEvent` streams to OTel-compatible spans; emits `gen_ai.*` semantic convention attributes (Datadog/Honeycomb/Grafana GenAI view compatible) with `semconvMode: "both" | "stable" | "legacy"`
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
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
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
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
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
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
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
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
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
  new AnthropicModel(AnthropicModels.SONNET_LATEST),
  [{ role: "user", content: "What are the trade-offs of microservices?" }]
);
console.log(result.answer);   // synthesised
console.log(result.branches); // individual paths
```

### Long-history compaction

```ts
import { CodeAgent, AnthropicModel, AnthropicModels, MessageAssembler } from "@agentkit-js/core";

const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);
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
const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);

// Third-party proxy or private endpoint
const proxied = new AnthropicModel(AnthropicModels.SONNET_LATEST, {
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

### Tool Deferred Loading (L1-1)

Exclude large MCP server tool schemas from the context prefix; load on-demand via Anthropic Tool Search. Reduces token usage by up to 85% on servers with many tools.

```ts
import { McpToolCollection, ToolCallingAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

// Option A: defer all tools from an MCP server with many tools.
const tools = await McpToolCollection.fromHttp("https://big-mcp-server.example.com");
tools.deferAll(); // marks all tools as deferLoading: true

// Option B: defer individual tools via the ToolDefinition field.
const myTool = {
  name: "my_tool",
  deferLoading: true,   // excluded from system prefix
  // ... other fields
};

const agent = new ToolCallingAgent({
  tools: tools.list(),
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
});
```

### Tool Use Examples (L1-2)

Provide few-shot examples to improve parameter accuracy from ~72% to ~90%.

```ts
const searchTool = {
  name: "search",
  description: "Search the web for information",
  inputSchema: z.object({ query: z.string(), maxResults: z.number().optional() }),
  inputExamples: [
    { query: "latest AI research 2026", maxResults: 5 },
    { query: "TypeScript best practices" },
  ],
  // ...
};
```

### Context Editing (L2-1)

Truncate old tool outputs reversibly to reduce context size without breaking conversation structure.

```ts
import { MessageAssembler, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);
const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new ToolCallingAgent({ tools, model, assembler, maxSteps: 50 });

// After many steps, truncate old tool outputs that are taking too many tokens.
// Keeps the 3 most recent tool steps verbatim; truncates older ones.
const truncated = agent.assembler.editToolResults({ maxTokens: 4096, keepRecent: 3 });
console.log(`Truncated ${truncated} tool outputs`);
```

### Cross-Session Memory Tool (L2-2)

Give agents persistent memory that survives across separate `run()` calls.

```ts
import { createMemoryTool, MapKvBackend, ToolCallingAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

// Use MapKvBackend for in-process use, or KvCheckpointer's backend for persistence.
const memory = createMemoryTool({ backend: new MapKvBackend() });

const agent = new ToolCallingAgent({
  tools: [memory, ...otherTools],
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
});

// Session 1: agent learns something
for await (const ev of agent.run("What's the capital of France? Remember it for later.")) { }

// Session 2: agent recalls it
for await (const ev of agent.run("What did you remember about France's capital?")) {
  if (ev.event === "final_answer") console.log(ev.data.answer); // "Paris"
}
```

### Programmatic Tool Calling / Self-Hosted PTC (L3-1)

Execute model-generated orchestration scripts inside a kernel; only the final result enters the context window.

```ts
import { ProgrammaticOrchestrator, JsKernel, ToolRegistry } from "@agentkit-js/core";

const kernel = new JsKernel();
const registry = new ToolRegistry();
registry.register(searchTool);
registry.register(calcTool);

const orchestrator = new ProgrammaticOrchestrator(kernel, registry, {
  extraCapabilities: ["tool:search", "tool:calc"],
});

// Model-generated script — intermediate results never enter the LLM context.
const script = `
  const results = callTool('search', { query: 'AI news 2026' });
  const count = callTool('calc', { expr: results.length + ' items' });
  count + ' found';
`;
const { finalOutput, toolCallCount } = await orchestrator.run(script);
console.log(finalOutput);    // Only this enters the context window.
console.log(toolCallCount);  // e.g. 2 — intermediate results stayed in the kernel.
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
