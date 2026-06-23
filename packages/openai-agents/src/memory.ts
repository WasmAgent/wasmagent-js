/**
 * @wasmagent/openai-agents — Memory tool adapter (D3, 2026-06-13).
 *
 * Exposes WasmAgent's `createMemoryTool` (cross-session KV-backed memory)
 * as an OpenAI Agents JS Tool.
 *
 * See `@wasmagent/aisdk/memory` for the rationale (D3 cross-framework
 * memory product surface).
 */
import { createMemoryTool as createMemoryToolCore, type MemoryToolOptions } from "@wasmagent/core";
import type { z } from "zod";

import type { OpenAiAgentTool } from "./index.js";

export function memoryAgentTool(opts: MemoryToolOptions): OpenAiAgentTool<unknown, string> {
  const core = createMemoryToolCore(opts);
  return {
    name: "memory",
    description: core.description,
    parameters: core.inputSchema as z.ZodType<unknown>,
    async execute(input) {
      return core.forward(input as never);
    },
  };
}

export { ObservationalMemory } from "@wasmagent/core";
export type { MemoryToolOptions };
