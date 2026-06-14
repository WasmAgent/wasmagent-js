# Memory in agentkit-js

> One-stop entry point. If you've heard of "agent memory" in 2026 — Mem0,
> Letta, Zep, OpenAI Sessions, Anthropic memory tool — this guide tells
> you which agentkit-js primitive is the equivalent, when each is the
> right call, and the failure modes to watch for.

agentkit-js ships **eight** memory-related primitives. They are not
alternative implementations — they are layers in a stack, and a real
production agent typically uses two or three at once. The decision
problem is not "which one do I pick", it's "which combination matches
my run lifecycle".

This guide is the map. The reference pages it links to are the
territory.

## TL;DR — decision tree

```
What do you need to retain?
├─ Steps inside the current agent.run() call
│  ├─ Just the message prefix, prompt-cache friendly
│  │  → MessageAssembler        (built-in to every agent)
│  ├─ Step-level summaries when context grows
│  │  → ObservationalMemory     (cheap observer model + KV)
│  └─ One small editable scratchpad
│     → MessageAssembler.setScratchpad()
│
├─ Identity and short-lived agent state visible every turn
│  → MemoryBlockSet             (Letta-style core memory)
│
├─ Cross-run user facts, preferences, learned skills
│  ├─ App writes them, app reads them
│  │  → StructuredMemory        (3 namespaces with TTL: episodic / semantic / procedural)
│  └─ Agent decides what to write/read
│     → createMemoryTool        (4-op tool; agent-callable CRUD)
│
├─ Documents the agent should retrieve at query time
│  ├─ One corpus, ephemeral
│  │  → InMemoryVectorStore + HybridRetriever
│  └─ Persistent index, scaled
│     → KvBackendVectorStore  /  Pinecone  /  Qdrant  (via @agentkit-js/tools-rag)
│
└─ Pause/resume an in-flight run across process restarts
   → Checkpointer               (KvCheckpointer for prod)
```

## What "memory" means in 2026 (and what agentkit calls each part)

The vendor landscape (Mem0, Letta, Zep, OpenAI Agents SDK, Anthropic
SDK, LangGraph, Microsoft Agent Framework) has converged on a small
number of distinct concepts. agentkit-js implements all of them; the
naming differs.

| 2026 industry concept | agentkit-js equivalent | Reference |
|---|---|---|
| Conversation history / Session (turn-by-turn) | `MessageAssembler` (in-run) + `Checkpointer` (cross-run) | [memory-patterns.md](./memory-patterns.md), [`MessageAssembler`](../../packages/core/src/memory/MessageAssembler.ts) |
| Core memory blocks (Letta) — editable in-context state | `MemoryBlockSet` + `coreMemoryTools()` | [§ Core memory blocks](#core-memory-blocks) below |
| Auto-extracted facts after each turn (Mem0) | `ObservationalMemory` (cheap-observer + priority ranking) | [observational-memory.md](./observational-memory.md) |
| Long-term namespaced KV (LangGraph `BaseStore`) | `StructuredMemory` (3 namespaces, TTL, decay) | [memory-patterns.md](./memory-patterns.md) |
| Model-callable memory tool (Anthropic `memory_20250818`) | `createMemoryTool()` (4-op CRUD) | [memory-patterns.md](./memory-patterns.md) |
| Hybrid retrieval (dense + sparse) | `HybridRetriever` (BM25 + dense + RRF) | [memory-patterns.md](./memory-patterns.md) |
| RAG over a corpus | `InMemoryVectorStore` / `KvBackendVectorStore` / `@agentkit-js/tools-rag` | [memory-patterns.md](./memory-patterns.md) |
| Bi-temporal knowledge graph (Zep / Graphiti) | **Not implemented** — bring your own graph store; we mark `valid_at` in `StructuredMemory` metadata if you need it | — |

The intentional gap: **bi-temporal entity graphs are Zep's product**.
Building a clone in agentkit-js would be 6-figure engineering with
mostly enterprise-ROI applications. agentkit-js leaves that adjacent.

## Pick by lifecycle, not by name

The cleanest mental model is "how long does this data live, and who
gets to write it?".

### Lifecycle A — within one `agent.run()` call

`MessageAssembler` is created once per agent, and tracks the message
prefix as steps accumulate. `ObservationalMemory` runs alongside it
and triggers an async observer model when the context grows past a
configurable threshold (default 6000 tokens), producing
priority-ranked summaries that compress the prefix without
invalidating the prompt cache.

You don't usually instantiate `MessageAssembler` directly — every
`ToolCallingAgent` / `CodeAgent` builds one internally. You DO
instantiate `ObservationalMemory` if you want continuous compression.
The reference page: [observational-memory.md](./observational-memory.md).

### Lifecycle B — across `agent.run()` calls in the same session

`MemoryBlockSet` is the new (2026-06) primitive for this lifecycle.
Pass it to the assembler via `memoryBlocks` config; it renders into a
user-role message right after the cached system prefix. Edit blocks
between runs (or let the agent edit them via `core_memory_append` /
`core_memory_replace`), and the next run sees the updated state.

```ts
import {
  MemoryBlockSet,
  coreMemoryTools,
  ToolCallingAgent,
  MessageAssembler,
} from "@agentkit-js/core";

const blocks = new MemoryBlockSet([
  { label: "persona", value: "I am a coding assistant." },
  { label: "human", value: "User name: Teller. Prefers TypeScript.", description: "current user" },
]);

const assembler = new MessageAssembler({
  systemPrompt: "You are a coding assistant.",
  toolsSchema: [...],
  memoryBlocks: blocks,
});

const agent = new ToolCallingAgent({
  model,
  tools: [...coreMemoryTools(blocks), ...otherTools],
  assembler,
});

// run 1: agent edits 'human' block via core_memory_append
// run 2: agent sees the updated 'human' block in its context
// (apply blocks.list() to a KV between runs if you want them to outlive the process)
```

**Cache stability**: blocks render in a separate user message — editing
a block does NOT invalidate the system prefix cache. This is
intentional and a deliberate divergence from Letta's "render in system
prompt" placement; see the design note in [`MemoryBlocks.ts`](../../packages/core/src/memory/MemoryBlocks.ts).

### Lifecycle C — across sessions (same user, different runs/days)

Two routes:

1. **Application-driven**: use `StructuredMemory`. Your app writes user
   facts to the `semantic` namespace; on each new run, your app reads
   them back and either injects into the system prompt or seeds a
   `MemoryBlockSet`. You decide schema; agent does not see the storage.

2. **Agent-driven**: use `createMemoryTool()`. Provide the tool to the
   agent; it learns to call `memory_write` after meaningful turns and
   `memory_read` at the start of new ones. You decide naming
   conventions in the system prompt; agent decides what is meaningful.

Most production setups combine both — application owns user-identity
keys (`user:42:profile`), agent owns content keys (`note:about:rust`).

### Lifecycle D — pause/resume across process restarts

`Checkpointer` is for human-in-the-loop pauses and crash recovery.
`InMemoryCheckpointer` for tests; `KvCheckpointer` (any `KvBackend`,
including Cloudflare KV / Redis / Durable Objects) for production. See
[memory-patterns.md](./memory-patterns.md) for the snapshot shape and
HITL approval pattern.

## Core memory blocks

This section expands the new (2026-06) `MemoryBlockSet` primitive.

### When to use

Core memory blocks are right for state that is:

- **Small** (a few hundred to a few thousand chars total)
- **Read every turn** (don't want a tool round-trip to access)
- **Editable mid-run** (agent or app updates it as the conversation
  progresses)
- **Per-session, not per-user-forever** (for long-term facts, use
  `StructuredMemory` instead)

Canonical examples: agent persona, current user identity, in-progress
task state, last few decisions made.

Anti-examples (use a different primitive): full conversation history
(use `MessageAssembler`), large documents (use `HybridRetriever`),
cross-session user profile (use `StructuredMemory`).

### How it differs from Letta

Letta renders core memory inside the system prompt. agentkit-js renders
it as a separate user-role message right after the cached system
prefix, so editing a block does not invalidate the prompt cache. The
practical impact: on Anthropic / Bedrock with prefix caching, an agent
that edits its block on every turn pays the cache cost once (the
system prefix), not per-turn (the modified block).

The agent-callable tool surface (`core_memory_append` /
`core_memory_replace`) is byte-compatible with Letta. An agent that
learned the Letta API works here unchanged.

### How it differs from `StructuredMemory`

| | `MemoryBlockSet` | `StructuredMemory` |
|---|---|---|
| Renders in every model call | yes (in user message) | no (only when app reads + injects, or via tool) |
| Persistence | in-memory by default; snapshot to KV manually | KV-backed by design |
| Size budget | small (default 5 blocks × 2000 chars) | unbounded (TTL-managed) |
| Edit cost | cheap (mutates in-memory map) | KV write (network) |
| Lifetime | one session | TTL or forever |

If you only need one of "always visible" or "long-term" — pick the
right one. If you need both, layer them: blocks render the
short-lived state; `StructuredMemory` stores the long-term facts the
app loads into blocks at session start.

## Pitfalls

### 1. Cache stability is not free

`MessageAssembler`, `MemoryBlockSet`, `ObservationalMemory` all assume
the system prefix is byte-stable across calls. This holds **only if you
don't edit `systemPrompt` mid-run**. Application code that templates
the user's name into the system prompt re-tokenizes the entire prefix
on every turn — at consumer-laptop latency that's fine, at production
scale it doubles cost. Move that into a `MemoryBlock` instead.

### 2. `MemoryTool` is opt-in, agent-judged

The agent decides what to remember. If your prompt does not encourage
memory writes, the agent will under-use it. The `createMemoryTool()`
docstring lists the recommended system-prompt addendum.

### 3. Decay is on-demand, not automatic

`StructuredMemory` does not run a background cron. Episodic entries
expire conceptually at 7 days but stay in storage until you call
`memory.decay()` or the access-time gate fires on read. Schedule a
periodic `decay()` if storage cost matters.

### 4. `ObservationalMemory` runs an additional model

The cheap observer model (typically Haiku or a local 0.5B) is a
**separate API call** with its own latency and cost. Total tokens go
up, even though context tokens go down. Net cost is favorable when
the agent run is long (>10 steps) and the observer is much cheaper
than the main model — see the math in
[observational-memory.md](./observational-memory.md).

### 5. Cross-session state is the application's problem

agentkit-js gives you the storage primitives; it does NOT give you a
"user model" or a "persona snapshot". Mem0 and Letta ship those at the
product layer because they are domain-specific (CRM-shaped vs.
coding-assistant-shaped vs. consumer-chat-shaped). If you want
auto-extracted user profiles, write the extractor in your app — or
adopt Mem0 alongside agentkit (they layer cleanly: Mem0 owns user
facts, agentkit owns the agent loop).

## Evaluating memory

agentkit-js ships two memory-related eval suites in
[`@agentkit-js/evals-runner`](../../packages/evals-runner/):

- **`multi-turn-memory`** (54 items, 6 categories) — tests recall
  across noise turns; matches LongMemEval's category structure
- **`long-context-recall`** — needle-in-haystack at 10% / 50% / 90%
  depths in ~16K-token contexts

For 2026 community benchmarks (LoCoMo-Refined, MemoryAgentBench),
see the `docs/reports/memory-eval-*.md` series.

## Reference pages

- [memory-patterns.md](./memory-patterns.md) — `StructuredMemory`,
  `createMemoryTool`, `HybridRetriever`, decay strategies
- [observational-memory.md](./observational-memory.md) — when the
  cheap-observer architecture is the right call, math behind the
  cost trade-off
- [`MemoryBlocks.ts`](../../packages/core/src/memory/MemoryBlocks.ts) —
  source for `MemoryBlockSet` and `coreMemoryTools()`
- [`MessageAssembler.ts`](../../packages/core/src/memory/MessageAssembler.ts) —
  the assembler with B1/B2 cache rules and the `memoryBlocks` slot
- [`Checkpointer`](../../packages/core/src/checkpoint/index.ts) —
  pause/resume contract

## What's deliberately not here

We did not implement Zep / Graphiti's bi-temporal entity graph
(`valid_at` / `invalid_at` fact invalidation, incremental graph
updates). That product is Zep's; if you need it, run Zep alongside
agentkit and have the agent call Graphiti via MCP. For 80% of agent
workloads — a code assistant, a customer support bot, a research
agent — the seven primitives above are sufficient.
