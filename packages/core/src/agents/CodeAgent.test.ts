import { z } from "zod";
import { CodeAgent } from "../agents/CodeAgent.js";
import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";

/** Creates a mock Model that streams a fixed response string. */
function mockModel(response: string): Model {
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: response };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

/** Echo tool for testing. */
const echoTool: ToolDefinition<{ text: string }, string> = {
  name: "echo",
  description: "Echoes text",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ text }) => text,
};

describe("CodeAgent", () => {
  it("emits run_start event", async () => {
    const agent = new CodeAgent({
      tools: [],
      model: mockModel("Final answer: 42"),
      maxSteps: 1,
    });
    const events = [];
    for await (const e of agent.run("test")) {
      events.push(e);
    }
    expect(events[0]?.event).toBe("run_start");
    const runStart = events.find((e) => e.event === "run_start");
    expect(runStart?.event === "run_start" && runStart.data.task).toBe("test");
  });

  it("emits final_answer when model returns final answer marker without code block", async () => {
    const agent = new CodeAgent({
      tools: [],
      model: mockModel("Final answer: 100"),
      maxSteps: 3,
    });
    const events = [];
    for await (const e of agent.run("What is 50+50?")) {
      events.push(e);
    }
    const finalEvent = events.find((e) => e.event === "final_answer");
    expect(finalEvent).toBeDefined();
  });

  it("executes code block and captures output", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock/test",
      async *generate(_msgs: ModelMessage[]): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          yield { type: "text_delta", delta: "```js\n__finalAnswer__ = 6 * 7;\n```" };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new CodeAgent({ tools: [], model, maxSteps: 5 });
    const events = [];
    for await (const e of agent.run("What is 6*7?")) {
      events.push(e);
    }
    const finalEvent = events.find((e) => e.event === "final_answer");
    expect(finalEvent).toBeDefined();
    expect(finalEvent?.event === "final_answer" && finalEvent.data.answer).toBe(42);
  });

  it("emits error event on kernel execution failure", async () => {
    const model: Model = {
      providerId: "mock/test",
      async *generate(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "```js\nthrow new Error('boom');\n```" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new CodeAgent({ tools: [], model, maxSteps: 1 });
    const events = [];
    for await (const e of agent.run("cause error")) {
      events.push(e);
    }
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
  });

  it("emits error event after maxSteps with no final answer", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock/test",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        yield { type: "text_delta", delta: `\`\`\`js\nconsole.log("step ${callCount}");\n\`\`\`` };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new CodeAgent({ tools: [], model, maxSteps: 2 });
    const events = [];
    for await (const e of agent.run("loop forever")) {
      events.push(e);
    }
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    expect(errEvent?.event === "error" && errEvent.data.error).toContain("max steps");
  });

  it("propagates parentTraceId in all events", async () => {
    const agent = new CodeAgent({
      tools: [],
      model: mockModel("done"),
      maxSteps: 1,
    });
    const events = [];
    for await (const e of agent.run("task", "parent-xyz")) {
      events.push(e);
    }
    for (const e of events) {
      expect(e.parentTraceId).toBe("parent-xyz");
    }
  });

  it("emits planning event at planningInterval", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock/test",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount >= 3) {
          yield { type: "text_delta", delta: "__finalAnswer__ done" };
        } else {
          yield { type: "text_delta", delta: `\`\`\`js\nconsole.log("s");\n\`\`\`` };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new CodeAgent({ tools: [], model, maxSteps: 5, planningInterval: 1 });
    const events = [];
    for await (const e of agent.run("task")) {
      events.push(e);
    }
    const planEvents = events.filter((e) => e.event === "planning");
    expect(planEvents.length).toBeGreaterThan(0);
  });

  it("registers and makes tools available to code via JSON schema", async () => {
    const agent = new CodeAgent({ tools: [echoTool], model: mockModel("no code"), maxSteps: 1 });
    const events = [];
    for await (const e of agent.run("test")) events.push(e);
    // Should not throw — tools were registered
    expect(events[0]?.event).toBe("run_start");
  });
});
