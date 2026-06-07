# agentkit-js

**TypeScript agent runtime with WASM sandboxing, prompt-cache optimization, and parallel quality runners.**

Build production-grade AI agents in TypeScript — code-execution agents, tool-calling agents, or multi-path reasoning pipelines — with built-in cost controls and Cloudflare Workers deployment.

```bash
pnpm add @agentkit-js/core @anthropic-ai/sdk
```

---

## Why agentkit-js?

| | Other JS agent libs | agentkit-js |
|---|---|---|
| **Code execution** | eval / no sandbox | WASM capability model (deny-all by default) |
| **Context cost** | Full history every step | Cache-stable prefix assembly + Anthropic prompt-caching |
| **Answer quality** | Single pass | Self-consistency, reflect-refine, budget forcing, parallel fork-join |
| **Concurrency** | Serial tool calls | DAG scheduler — independent tools run in parallel |
| **Edge deployment** | Node.js only | Cloudflare Workers out of the box |
| **Python support** | No | CPython-in-WASM via Pyodide |

---

## Features

- **Two agent modes** — `CodeAgent` (writes + executes code) and `ToolCallingAgent` (native tool_use)
- **WASM sandboxing** — `JsKernel` enforces capability manifests; `PyodideKernel` runs CPython in WASM; `WasmtimeKernel` for true WASM memory isolation
- **Prompt-cache optimization** — `MessageAssembler` builds cache-stable prefixes; Anthropic `cache_control` breakpoints reduce token cost on long runs
- **Quality runners** — majority-vote self-consistency, critique-refine cycles, "Wait" prefill budget forcing, parallel fork-join with synthesis
- **DAG scheduling** — independent tool calls execute concurrently; read-only tools speculatively pre-execute ahead of barriers
- **Long-history compaction** — `MessageAssembler.compact()` summarises old steps with the model to stay within context limits
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

const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new CodeAgent({
  tools: [],
  model: new AnthropicModel(AnthropicModels.CLAUDE_SONNET_4),
  maxSteps: 50,
  assembler,
});

// Summarise old steps, keep context window in check
await assembler.compact(agent.model, { keepRecentSteps: 5 });
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
| `@agentkit-js/core` | Agent runtime, kernels, models, tools, quality runners |
| `@agentkit-js/cli` | `agentkit run` CLI |
| `@agentkit-js/kernel-pyodide` | CPython-in-WASM (Pyodide) |
| `@agentkit-js/kernel-quickjs` | QuickJS WASM kernel |
| `@agentkit-js/kernel-wasmtime` | True WASM sandbox via Javy + WASI (requires `javy` CLI) |
| `@agentkit-js/cloudflare-worker` | Cloudflare Workers HTTP entry point |

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
