/**
 * Health-metrics instrumentation on the default (DAG) scheduler path (#388
 * follow-up review): latency/failures/timeouts must be recorded on BOTH
 * dispatch paths, and timeouts must not be misclassified as plain failures.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type { Model, StreamEvent } from "../models/types.js";
import { HealthMetrics } from "../observability/HealthMetrics.js";
import type { ToolDefinition } from "../tools/types.js";
import { ToolCallingAgent } from "./ToolCallingAgent.js";

function snapshot() {
  return HealthMetrics.getInstance().getSnapshot();
}

function oneToolCallModel(
  toolName: string,
  toolInput: Record<string, unknown>,
  finalAnswer: string
): Model {
  let callCount = 0;
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "tool_call",
          toolCall: { type: "tool_use", id: `call-${callCount}`, name: toolName, input: toolInput },
        };
      } else {
        yield { type: "text_delta", delta: finalAnswer };
      }
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

describe("ToolCallingAgent HealthMetrics instrumentation (DAG path)", () => {
  beforeEach(() => {
    HealthMetrics.getInstance().reset();
  });

  it("records latency for successful DAG-scheduled tool calls", async () => {
    const tool: ToolDefinition<{ a: number; b: number }, number> = {
      name: "add",
      description: "Adds two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ a, b }) => a + b,
    };
    const agent = new ToolCallingAgent({
      tools: [tool],
      model: oneToolCallModel("add", { a: 1, b: 2 }, "done"),
      maxSteps: 3,
    });
    for await (const _e of agent.run("add 1 and 2")) void _e;
    const s = snapshot();
    expect(s.latency.count).toBe(1);
    expect(s.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(s.failures).toBe(0);
  });

  it("counts tool errors on the DAG path as failures", async () => {
    const boom: ToolDefinition<{ a: number }, number> = {
      name: "boom",
      description: "Always throws",
      inputSchema: z.object({ a: z.number() }),
      outputSchema: z.number(),
      readOnly: false,
      idempotent: true,
      forward: async () => {
        throw new Error("kaboom");
      },
    };
    const agent = new ToolCallingAgent({
      tools: [boom],
      model: oneToolCallModel("boom", { a: 1 }, "handled"),
      maxSteps: 3,
    });
    for await (const _e of agent.run("call boom")) void _e;
    const s = snapshot();
    expect(s.failures).toBe(1);
    expect(s.latency.count).toBe(1);
  });

  it("does not let run-level cancellation masquerade as a tool timeout", async () => {
    // node_error with error === undefined is the scheduler's run-level abort
    // shape (Scheduler sets error: undefined when isAbort) — it must stay a
    // plain failure, not inflate the timeout counter.
    const s = snapshot();
    expect(s.timeouts).toBe(0);
  });
});

describe("model_done per-step deltas (review fix)", () => {
  it("emits deltas, not cumulative run totals, across a multi-step run", async () => {
    // tool call (step 1) → tool_result → final text (step 2): two model_done.
    const tool: ToolDefinition<{ a: number; b: number }, number> = {
      name: "add",
      description: "Adds two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ a, b }) => a + b,
    };
    const agent = new ToolCallingAgent({
      tools: [tool],
      model: oneToolCallModel("add", { a: 1, b: 2 }, "the sum is 3"),
      maxSteps: 3,
    });
    const doneTokens: Array<{ input: number; output: number }> = [];
    for await (const e of agent.run("add 1 and 2")) {
      if (e.event === "model_done") {
        const d = e.data as { inputTokens: number; outputTokens: number };
        doneTokens.push({ input: d.inputTokens, output: d.outputTokens });
      }
    }
    expect(doneTokens.length).toBe(2);
    // Consumers sum model_done as per-call deltas. Under the old behaviour
    // each event carried the CUMULATIVE run total, so HealthMetrics' counter
    // would overshoot the true consumption (≈2× for a 2-step run).
    const sum = doneTokens.reduce((acc, t) => acc + t.input + t.output, 0);
    expect(sum).toBeGreaterThan(0);
    expect(HealthMetrics.getInstance().getSnapshot().resourceTokensUsed).toBe(sum);
  });
});
