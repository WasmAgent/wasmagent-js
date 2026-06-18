/**
 * @wasmagent/claude-agent-sdk — Memory tool adapter (D3, 2026-06-13).
 *
 * Exposes agentkit's `createMemoryTool` (cross-session KV-backed memory)
 * as a Claude Agent SDK tool quadruple.
 *
 * See `@wasmagent/aisdk/memory` for the rationale (D3 cross-framework
 * memory product surface).
 */
import {
  createMemoryTool as createMemoryToolCore,
  type MemoryToolOptions,
  zodToJsonSchema,
} from "@wasmagent/core";

import type { ClaudeAgentTool } from "./index.js";

export function memoryClaudeTool(opts: MemoryToolOptions): ClaudeAgentTool {
  const core = createMemoryToolCore(opts);
  // Convert the Zod discriminated union to a JSON Schema for the Claude
  // Agent SDK input_schema slot. The conversion is faithful — the same
  // helper core uses internally.
  const schema = zodToJsonSchema(core.inputSchema as never) as ClaudeAgentTool["input_schema"];
  return {
    name: "memory",
    description: core.description,
    input_schema: schema,
    async handler(input: unknown) {
      return core.forward(input as never);
    },
  };
}

export { ObservationalMemory } from "@wasmagent/core";
export type { MemoryToolOptions };
