/**
 * #137 — Agent Tools: store.asTools()
 *
 * Exposes SharedStateStore as LLM-callable tools:
 * - read_state: returns projected state + affordances
 * - dispatch_action: validates and applies a semantic action
 */

import { z } from "zod";
import type { ToolDefinition } from "../tools/types.js";
import type { SharedStateStore } from "./SharedStateStore.js";

/** Options for stateTools generation. */
export interface StateToolsOpts {
  /** Name for the read tool. Default: "read_state". */
  readToolName?: string;
  /** Name for the dispatch tool. Default: "dispatch_action". */
  dispatchToolName?: string;
  /** Source identifier for dispatched actions. Default: "agent". */
  source?: string;
}

/**
 * Generate tool definitions that let an LLM interact with a SharedStateStore.
 *
 * - read_state: reads the current projection + affordances
 * - dispatch_action: validates and dispatches a semantic action
 */
export function stateTools<S, A extends { type: string }>(
  store: SharedStateStore<S, A>,
  sessionId: string,
  opts?: StateToolsOpts
): ToolDefinition[] {
  const readName = opts?.readToolName ?? "read_state";
  const dispatchName = opts?.dispatchToolName ?? "dispatch_action";
  const source = opts?.source ?? "agent";
  const model = store.model;

  const readTool: ToolDefinition<Record<string, never>, unknown> = {
    name: readName,
    description:
      "Read the current shared state projection and available affordances (valid action types).",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    readOnly: true,
    idempotent: true,
    async forward(): Promise<unknown> {
      const state = await store.get(sessionId);
      const projection = model.project ? model.project(state) : state;
      const affordances = model.affordances ? model.affordances(state) : undefined;
      return { projection, affordances };
    },
  };

  const dispatchTool: ToolDefinition<{ action: Record<string, unknown> }, unknown> = {
    name: dispatchName,
    description:
      "Dispatch a semantic action to update shared state. The action must have a 'type' field and conform to the state model's action schema.",
    inputSchema: z.object({
      action: z.record(z.unknown()).refine((a) => typeof a.type === "string", {
        message: "Action must have a string 'type' field",
      }),
    }),
    outputSchema: z.unknown(),
    readOnly: false,
    idempotent: false,
    async forward(input: { action: Record<string, unknown> }): Promise<unknown> {
      // Validate action if model supports it
      let action: A;
      if (model.validate) {
        action = model.validate(input.action);
      } else {
        action = input.action as A;
      }

      // Check affordances
      if (model.affordances) {
        const state = await store.get(sessionId);
        const allowed = model.affordances(state);
        if (!allowed.includes(action.type)) {
          return {
            error: `Action type "${action.type}" is not currently allowed. Allowed: ${allowed.join(", ")}`,
          };
        }
      }

      const next = await store.dispatch(sessionId, action, { source });
      const projection = model.project ? model.project(next) : next;
      return { ok: true, projection };
    },
  };

  return [readTool as ToolDefinition, dispatchTool as ToolDefinition];
}
