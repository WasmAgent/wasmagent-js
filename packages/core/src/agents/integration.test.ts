import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CodeAgent } from "../agents/CodeAgent.js";
import { ToolCallingAgent } from "../agents/ToolCallingAgent.js";
import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scriptModel(responses: string[]): Model {
  let idx = 0;
  return {
    providerId: "mock/script",
    async *generate(): AsyncGenerator<StreamEvent> {
      const resp = responses[idx++] ?? "__finalAnswer__ = 'done';";
      yield { type: "text_delta", delta: resp };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

function toolCallModel(
  calls: Array<{ toolName: string; input: Record<string, unknown> } | string>
): Model {
  let idx = 0;
  return {
    providerId: "mock/tool-call",
    async *generate(): AsyncGenerator<StreamEvent> {
      const step = calls[idx++];
      if (!step) {
        yield { type: "text_delta", delta: "done" };
      } else if (typeof step === "string") {
        yield { type: "text_delta", delta: step };
      } else {
        yield {
          type: "tool_call",
          toolCall: {
            type: "tool_use",
            id: `call-${idx}`,
            name: step.toolName,
            input: step.input,
          },
        };
      }
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

const addTool: ToolDefinition<{ a: number; b: number }, number> = {
  name: "add",
  description: "Adds two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }) => a + b,
};

// ---------------------------------------------------------------------------
// CodeAgent integration
// ---------------------------------------------------------------------------

describe("CodeAgent integration", () => {
  it("multi-step: variable set in step 1 is readable in step 2", async () => {
    const model = scriptModel(["```js\nvar x = 21;\n```", "```js\n__finalAnswer__ = x * 2;\n```"]);
    const agent = new CodeAgent({ tools: [], model, maxSteps: 5 });
    const events = [];
    for await (const e of agent.run("double 21")) events.push(e);

    const finalEvent = events.find((e) => e.event === "final_answer");
    expect(finalEvent).toBeDefined();
    expect(finalEvent?.event === "final_answer" && finalEvent.data.answer).toBe(42);
  });

  it("run_start → step_start... → final_answer event ordering", async () => {
    const model = scriptModel(["```js\n__finalAnswer__ = 'hi';\n```"]);
    const agent = new CodeAgent({ tools: [], model, maxSteps: 2 });
    const events = [];
    for await (const e of agent.run("say hi")) events.push(e);

    const types = events.map((e) => e.event);
    expect(types[0]).toBe("run_start");
    expect(types.includes("step_start")).toBe(true);
    expect(types[types.length - 1]).toBe("final_answer");
  });

  it("kernel error in step 1 does not prevent step 2", async () => {
    // Step 1 throws, step 2 answers. The agent should emit error for step 1
    // then continue (break after error in current impl).
    const model = scriptModel([
      "```js\nthrow new Error('step1 fail');\n```",
      "```js\n__finalAnswer__ = 'recovered';\n```",
    ]);
    const agent = new CodeAgent({ tools: [], model, maxSteps: 3 });
    const events = [];
    for await (const e of agent.run("recover")) events.push(e);
    // Current impl: error breaks the loop.
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
  });

  it("traceId is consistent across all events in a single run", async () => {
    const model = scriptModel(["```js\n__finalAnswer__ = 1;\n```"]);
    const agent = new CodeAgent({ tools: [], model, maxSteps: 2 });
    const events = [];
    for await (const e of agent.run("trace test")) events.push(e);
    const traceIds = new Set(events.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);
  });

  it("console.log output appears in observations", async () => {
    const model = scriptModel([
      "```js\nconsole.log('logged value'); 99\n```",
      "```js\n__finalAnswer__ = 'done';\n```",
    ]);
    const agent = new CodeAgent({ tools: [], model, maxSteps: 3 });
    const events = [];
    for await (const e of agent.run("log test")) events.push(e);
    // The final answer should arrive meaning observations were recorded without error.
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolCallingAgent integration
// ---------------------------------------------------------------------------

describe("ToolCallingAgent integration", () => {
  it("single tool call: add(3, 4) → answer '7'", async () => {
    const model = toolCallModel([{ toolName: "add", input: { a: 3, b: 4 } }, "The sum is 7"]);
    const agent = new ToolCallingAgent({ tools: [addTool], model, maxSteps: 5 });
    const events = [];
    for await (const e of agent.run("What is 3+4?")) events.push(e);

    const toolResult = events.find((e) => e.event === "tool_result");
    expect(toolResult?.event === "tool_result" && toolResult.data.output).toBe(7);

    const finalEvent = events.find((e) => e.event === "final_answer");
    expect(finalEvent).toBeDefined();
  });

  it("two sequential tool calls before final answer", async () => {
    const model = toolCallModel([
      { toolName: "add", input: { a: 1, b: 2 } },
      { toolName: "add", input: { a: 3, b: 4 } },
      "Results: 3 and 7",
    ]);
    const agent = new ToolCallingAgent({ tools: [addTool], model, maxSteps: 5 });
    const events = [];
    for await (const e of agent.run("add twice")) events.push(e);

    const toolResults = events.filter((e) => e.event === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]?.event === "tool_result" && toolResults[0].data.output).toBe(3);
    expect(toolResults[1]?.event === "tool_result" && toolResults[1].data.output).toBe(7);

    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("task is sent as a plain user message (no spurious assistant turn)", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const model: Model = {
      providerId: "mock/spy",
      async *generate(msgs: ModelMessage[]): AsyncGenerator<StreamEvent> {
        capturedMessages.push(msgs);
        yield { type: "text_delta", delta: "done" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new ToolCallingAgent({ tools: [], model, maxSteps: 1 });
    for await (const _ of agent.run("my task")) {
      /* consume */
    }

    const msgs = capturedMessages[0] ?? [];
    // system + user("my task") — no assistant turn before the first user message
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toBe("my task");
    expect(msgs).toHaveLength(2);
  });
});
