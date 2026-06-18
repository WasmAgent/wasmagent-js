/**
 * @wasmagent/aisdk — Memory tool adapters (D3, 2026-06-13).
 *
 * Exposes agentkit's `createMemoryTool` (cross-session KV-backed memory)
 * as a Vercel AI SDK `tool()` so the same memory primitive plays nicely in
 * an AI SDK agent without wrapping or re-implementation.
 *
 * Why this exists
 * ===============
 *
 * The memory-layer market in 2026 has consolidated around two signals:
 *
 *   1. Adapters across ≥10 frameworks, not lock-in to one. (Mem0
 *      shipped 21-framework integration in 2026-Q1 explicitly because
 *      "framework-locked memory layers do not get adopted at scale".)
 *   2. Reported on (accuracy, cost-per-query) Pareto axes — not
 *      single-axis accuracy. Mastra's Observational Memory headline
 *      number (94.87% LongMemEval) is impressive, but the
 *      cost-per-correct axis is where small teams beat the platforms.
 *
 * agentkit-js already has `createMemoryTool` (KV-backed) and
 * `ObservationalMemory` (continuous compression, prompt-cache-stable).
 * Until D3 they were only consumable from inside agentkit — meaning the
 * memory primitive was effectively framework-locked despite the kernels
 * being framework-agnostic.
 *
 * This file makes them framework-portable: you can use the *same*
 * `createMemoryTool` shipped in `@wasmagent/core` from a Vercel AI SDK
 * project without writing your own adapter. The `@wasmagent/claude-agent-sdk`
 * and `@wasmagent/openai-agents` packages ship their own thin wrappers
 * with the same shape; see those READMEs.
 *
 * Note on `ObservationalMemory`
 * =============================
 *
 * `ObservationalMemory` is NOT a tool — it sits on a `MessageAssembler`
 * and compresses history into a planning step. There is no clean way to
 * expose it as an AI SDK `tool()` because the AI SDK manages its own
 * message list. Instead, we re-export the class so consumers running an
 * `Agent` loop with an agentkit `MessageAssembler` (e.g. `aisdk-bridge.ts`)
 * can drop it in directly. End-to-end Vercel AI SDK integration is
 * tracked under D3 phase 2 — see ROADMAP for the message-list shim plan.
 */

import { createMemoryTool as createMemoryToolCore, type MemoryToolOptions } from "@wasmagent/core";
import type { ZodType } from "zod";

import type { AiSdkToolDefinition } from "./index.js";

/**
 * Vercel AI SDK shape for the memory tool. Wraps `createMemoryTool` from
 * `@wasmagent/core` so that an AI SDK agent can persist facts across
 * runs through the same KvBackend you already use for checkpoints.
 *
 * Returned shape is structurally compatible with the AI SDK's `tool()`
 * helper — pass directly into `tools: { memory: memoryTool({...}) }`.
 */
export function memoryTool(opts: MemoryToolOptions): AiSdkToolDefinition<unknown, string> {
  const core = createMemoryToolCore(opts);
  return {
    description: core.description,
    // The core tool's inputSchema is a Zod discriminated union; the AI SDK
    // accepts any Zod schema in `parameters`.
    parameters: core.inputSchema as ZodType<unknown>,
    async execute(input) {
      return core.forward(input as never);
    },
  };
}

// Re-export ObservationalMemory so AI SDK consumers running an agentkit
// MessageAssembler can wire it up without an extra import.
export { ObservationalMemory } from "@wasmagent/core";
// Re-export the underlying types for callers wiring custom backends.
export type { MemoryToolOptions };
