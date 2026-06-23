# Production APIs

### Retry / Resilience (C1)

All model adapters automatically retry 429 / 5xx / network errors with exponential backoff + jitter:

```ts
import { AnthropicModel } from "@wasmagent/core";

const model = new AnthropicModel("claude-sonnet-4-6", {
  apiKey: process.env.ANTHROPIC_API_KEY,
  retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000 },
});
```

### Evals (B1)

```ts
import { runEval, exactMatch, toolCallAccuracy } from "@wasmagent/core";

const results = await runEval(dataset, async function* (task) {
  yield* agent.run(task);
}, [exactMatch, toolCallAccuracy]);
```

### OpenTelemetry Bridge (C2)

```ts
import { OtelBridge, InMemorySpanExporter, withOtel } from "@wasmagent/core";

const exporter = new InMemorySpanExporter(); // swap for OTLP in production
const bridge = new OtelBridge({ exporter });
for await (const ev of withOtel(agent.run(task), bridge)) {
  console.log(ev);
}
bridge.flush();
```

### Durable runtime — Checkpoints, SSE resume, HITL

Pick **one** `KvBackend` and use it for checkpoints, the SSE event log, and structured memory — there is one canonical contract.

```ts
import {
  CheckpointableRun,
  EventLog,
  KvCheckpointer,
  resumeFromHuman,
  applyHumanResponse,
  restoreFromSnapshot,
} from "@wasmagent/core";
// Pick a backend that matches your runtime.
import { CloudflareKvBackend } from "@wasmagent/cloudflare-worker";
// Other options: DurableObjectKvBackend (CF), RedisKvBackend (Node/Bun),
// RedisRestKvBackend (Upstash, edge-safe), MapKvBackend (tests).

const kv = new CloudflareKvBackend(env.MY_KV);
const checkpointer = new KvCheckpointer(kv);
const log = new EventLog(kv); // SSE Last-Event-ID resume
const wrapper = new CheckpointableRun({ checkpointer }, agent.assembler);

// Stream + persist + tag every event with a monotonic id.
for await (const { eventId, event } of log.tap(
  wrapper.run(agent.run(task), task, traceId),
  traceId,
)) {
  // emit `id: ${eventId}\nevent: ${event.event}\ndata: ${...}\n\n` over SSE
  if (event.event === "await_human_input") {
    // Snapshot is already persisted; the worker is free to exit.
    return;
  }
}
```

**Resume after a worker recycle** (different process, possibly different machine):

```ts
const lastId = req.headers.get("Last-Event-ID");
for await (const { eventId, event } of log.replay(traceId, lastId)) { /* re-emit */ }
const startSeq = await log.nextSeq(traceId);
for await (const { eventId, event } of log.tap(agent.run(task, traceId), traceId, { startSeq })) { /* live tail */ }
```

**Resume after human approval** (could be hours/days later):

```ts
// In the /resume HTTP handler — stateless, returns immediately.
await resumeFromHuman(checkpointer, traceId, promptId, response);

// Later, when a worker picks up the trace:
const snap = await checkpointer.load(traceId);
restoreFromSnapshot(snap, agent.assembler);
applyHumanResponse(snap, agent.assembler); // injects user_message into history
// Then continue with `wrapper.run(agent.run(snap.task, traceId), ...)`.
```

The reference Cloudflare Worker (`@wasmagent/cloudflare-worker`) wires all of this for you — bind `WASMAGENT_EVENT_LOG` and `WASMAGENT_CHECKPOINTS` in `wrangler.toml` and you get `Last-Event-ID` resume + a `POST /resume` endpoint out of the box. Full guide: [docs/guides/durable-runtime.md](docs/guides/durable-runtime.md).

### React Hook (B2)

```tsx
import { useAgentRun } from "@wasmagent/react";

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
import { McpToolCollection, ToolCallingAgent, AnthropicModel, AnthropicModels } from "@wasmagent/core";

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
import { MessageAssembler, AnthropicModel, AnthropicModels } from "@wasmagent/core";

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
import { createMemoryTool, MapKvBackend, ToolCallingAgent, AnthropicModel, AnthropicModels } from "@wasmagent/core";

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
import { ProgrammaticOrchestrator, JsKernel, ToolRegistry } from "@wasmagent/core";

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
