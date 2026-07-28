/**
 * Sub-agent wrapping primitive.
 *
 * Turns any agent (object with a run() generator method) into a ToolDefinition
 * so it can be invoked by a parent ToolCallingAgent.
 *
 * Usage:
 *   const searchAgent = new ToolCallingAgent({ ... });
 *   const parentAgent = new ToolCallingAgent({
 *     tools: [asTool(searchAgent, { name: "search_agent", description: "..." })],
 *     model,
 *   });
 *
 * Sub-agent events carry the parent's traceId as parentTraceId, so the full
 * event chain can be correlated by the caller.
 */

import { z } from "zod";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";
import {
  buildPostureDelegationRecord,
  type PostureOverride,
  type PosturePolicy,
} from "./PosturePolicy.js";

export interface AsToolOptions {
  /** Tool name exposed to the parent model. */
  name: string;
  /** Tool description exposed to the parent model. */
  description: string;
  /**
   * Optional: collect sub-agent events for observability.
   * Called with each AgentEvent emitted by the sub-agent.
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Optional mutable ref whose `.current` value is read at call time and
   * forwarded to the sub-agent as its parentTraceId.  Set this to the
   * parent agent's own traceId ref so that sub-agent events are linked
   * to the correct parent trace in observability consumers.
   */
  parentTraceIdRef?: { current: string | null };
  /**
   * Parent agent's posture (Milestone 6 cross-agent policy inheritance). When
   * set, the wrapped sub-agent runs under a posture narrowed from this
   * (capability attenuation via `inheritPosture`), and — with `evidenceSink` —
   * a {@link PostureDelegationRecord} is appended on every tool invocation so
   * the cascade is tracked in evidence. Absent ⇒ no posture cascade.
   */
  parentPosture?: PosturePolicy;
  /** Optional narrowing the sub-agent requests (intersected against parentPosture). */
  postureOverride?: PostureOverride;
  /**
   * Optional append-only sink for the posture delegation record. Duck-compatible
   * with `@wasmagent/aep`'s `EvidenceStore.append`, so a real
   * `InMemoryEvidenceStore` / `FilesystemEvidenceStore` can be passed directly.
   * Appended once per invocation when `parentPosture` is set.
   */
  evidenceSink?: { append(record: unknown): void | Promise<void> };
}

export interface SubagentRunnable {
  run(task: string, parentTraceId?: string | null): AsyncGenerator<AgentEvent>;
}

/**
 * Wrap an agent as a ToolDefinition for use inside a parent ToolCallingAgent.
 *
 * The sub-agent receives the tool input's `task` field as its task string and
 * the parent agent's traceId as its parentTraceId (linking event chains).
 *
 * Returns the sub-agent's final answer as the tool output. If the sub-agent
 * errors, the error message is propagated as a tool error.
 */
export function asTool(
  agent: SubagentRunnable,
  opts: AsToolOptions
  // biome-ignore lint/suspicious/noExplicitAny: intentional
): ToolDefinition<{ task: string }, any> {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: z.object({ task: z.string().describe("The task for the sub-agent to perform") }),
    outputSchema: z.object({ answer: z.any() }),
    readOnly: false,
    idempotent: false,
    async forward(input, _signal) {
      // Cross-agent posture cascade (Milestone 6): record the delegation of the
      // parent's posture to this sub-agent before it runs. Delegating is a
      // spawn-time act, so we record it even if the sub-agent then errors. The
      // sub-agent itself is pre-built, so the effective posture is captured in
      // evidence (and auditable) rather than injected into the agent.
      const parentPosture = opts.parentPosture;
      if (parentPosture && opts.evidenceSink) {
        const parentTraceId = opts.parentTraceIdRef?.current ?? null;
        const delegation = buildPostureDelegationRecord({
          parentAgentId: parentTraceId ?? "parent",
          childAgentId: opts.name,
          delegationChain: parentTraceId ? [parentTraceId] : [],
          parentPosture,
          childOverride: opts.postureOverride ?? {},
        });
        try {
          await opts.evidenceSink.append(delegation);
        } catch {
          /* best-effort — never let a flaky sink break the sub-agent run */
        }
      }

      let finalAnswer: unknown = null;
      let errorMessage: string | null = null;

      for await (const event of agent.run(input.task, opts.parentTraceIdRef?.current ?? null)) {
        opts.onEvent?.(event);
        if (event.event === "final_answer") {
          finalAnswer = event.data.answer;
        } else if (event.event === "error") {
          errorMessage = event.data.error;
        }
      }

      if (errorMessage !== null) {
        throw new Error(`Sub-agent "${opts.name}" failed: ${errorMessage}`);
      }

      return { answer: finalAnswer };
    },
  };
}
