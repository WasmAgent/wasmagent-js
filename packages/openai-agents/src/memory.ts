/**
 * @agentkit-js/openai-agents — Memory tool adapter (D3, 2026-06-13).
 *
 * Exposes agentkit's `createMemoryTool` (cross-session KV-backed memory)
 * as an OpenAI Agents JS Tool.
 *
 * See `@agentkit-js/aisdk/memory` for the rationale (D3 cross-framework
 * memory product surface).
 */
import {
  createMemoryTool as createMemoryToolCore,
  type MemoryToolOptions,
} from "@agentkit-js/core";
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

export { ObservationalMemory } from "@agentkit-js/core";
export type { MemoryToolOptions };
