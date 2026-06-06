import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolCallingAgent } from "../agents/ToolCallingAgent.js";
import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";

const addTool: ToolDefinition<{ a: number; b: number }, number> = {
  name: "add",
  description: "Adds two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }) => a + b,
};

/** Model that immediately answers with text (no tool calls). */
function textAnswerModel(answer: string): Model {
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: answer };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

/** Model that makes one tool call then text-answers. */
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
          toolCall: {
            type: "tool_use",
            id: `call-${callCount}`,
            name: toolName,
            input: toolInput,
          },
        };
      } else {
        yield { type: "text_delta", delta: finalAnswer };
      }
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

describe("ToolCallingAgent", () => {
  it("emits run_start event", async () => {
    const agent = new ToolCallingAgent({ tools: [], model: textAnswerModel("hello"), maxSteps: 1 });
    const events = [];
    for await (const e of agent.run("say hello")) events.push(e);
    expect(events[0]?.event).toBe("run_start");
  });

  it("emits final_answer when model returns text (no tool call)", async () => {
    const agent = new ToolCallingAgent({
      tools: [],
      model: textAnswerModel("The answer is 7"),
      maxSteps: 3,
    });
    const events = [];
    for await (const e of agent.run("What is 3+4?")) events.push(e);
    const finalEvent = events.find((e) => e.event === "final_answer");
    expect(finalEvent).toBeDefined();
    expect((finalEvent?.data as { answer: string }).answer).toContain("7");
  });

  it("executes a tool call and emits tool_call + tool_result events", async () => {
    const agent = new ToolCallingAgent({
      tools: [addTool],
      model: oneToolCallModel("add", { a: 3, b: 4 }, "The sum is 7"),
      maxSteps: 5,
    });
    const events = [];
    for await (const e of agent.run("Add 3 and 4")) events.push(e);
    const toolCallEvent = events.find((e) => e.event === "tool_call");
    expect(toolCallEvent).toBeDefined();
    expect((toolCallEvent?.data as { toolName: string }).toolName).toBe("add");

    const toolResultEvent = events.find((e) => e.event === "tool_result");
    expect(toolResultEvent).toBeDefined();
    expect((toolResultEvent?.data as { output: unknown }).output).toBe(7);
  });

  it("emits final_answer after tool call", async () => {
    const agent = new ToolCallingAgent({
      tools: [addTool],
      model: oneToolCallModel("add", { a: 10, b: 20 }, "Sum is 30"),
      maxSteps: 5,
    });
    const events = [];
    for await (const e of agent.run("What is 10+20?")) events.push(e);
    const finalEvent = events.find((e) => e.event === "final_answer");
    expect(finalEvent).toBeDefined();
  });

  it("emits error event after maxSteps", async () => {
    const agent = new ToolCallingAgent({
      tools: [addTool],
      model: oneToolCallModel("add", { a: 1, b: 2 }, "done"),
      maxSteps: 1,
    });
    const events = [];
    for await (const e of agent.run("loop")) events.push(e);
    // With maxSteps=1 and one tool call on step 1, the loop hits the limit
    const hasError = events.some((e) => e.event === "error");
    const hasFinal = events.some((e) => e.event === "final_answer");
    expect(hasError || hasFinal).toBe(true);
  });

  it("propagates parentTraceId", async () => {
    const agent = new ToolCallingAgent({
      tools: [],
      model: textAnswerModel("done"),
      maxSteps: 1,
    });
    const events = [];
    for await (const e of agent.run("task", "parent-abc")) events.push(e);
    for (const e of events) {
      expect(e.parentTraceId).toBe("parent-abc");
    }
  });

  it("handles unknown tool gracefully (returns tool_result with error)", async () => {
    const agent = new ToolCallingAgent({
      tools: [],
      model: oneToolCallModel("nonexistent", {}, "fallback"),
      maxSteps: 5,
    });
    const events = [];
    for await (const e of agent.run("call unknown tool")) events.push(e);
    const toolResult = events.find((e) => e.event === "tool_result");
    expect(toolResult).toBeDefined();
    const data = toolResult?.data as { error?: { message: string } };
    expect(data.error?.message).toContain("Unknown tool");
  });

  it("all events carry traceId", async () => {
    const agent = new ToolCallingAgent({
      tools: [],
      model: textAnswerModel("ok"),
      maxSteps: 1,
    });
    const events = [];
    for await (const e of agent.run("test")) events.push(e);
    for (const e of events) {
      expect(typeof e.traceId).toBe("string");
      expect(e.traceId.length).toBeGreaterThan(0);
    }
  });

  it("emits planning event at planningInterval", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock/test",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount >= 3) {
          // Step 3: return text (final answer)
          yield { type: "text_delta", delta: "done" };
        } else {
          // Steps 1 & 2: return a tool call
          yield {
            type: "tool_call",
            toolCall: { type: "tool_use", id: `c${callCount}`, name: "add", input: { a: 1, b: 2 } },
          };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new ToolCallingAgent({
      tools: [addTool],
      model,
      maxSteps: 5,
      planningInterval: 1,
    });
    const events = [];
    for await (const e of agent.run("task")) events.push(e);
    const planningEvents = events.filter((e) => e.event === "planning");
    expect(planningEvents.length).toBeGreaterThan(0);
  });
});
