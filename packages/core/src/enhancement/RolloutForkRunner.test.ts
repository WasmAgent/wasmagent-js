import { z } from "zod";
import type { Model, StreamEvent } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { Retriever, SearchResult } from "../memory/Retriever.js";
import { RolloutMemoryStore } from "./RolloutMemoryStore.js";
import { RolloutForkRunner } from "./RolloutForkRunner.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

const echoTool: ToolDefinition<{ msg: string }, string> = {
  name: "echo",
  description: "Echo a message",
  inputSchema: z.object({ msg: z.string() }),
  readOnly: true,
  idempotent: true,
  forward: async ({ msg }) => msg,
};

/**
 * Factory that creates a fresh model per branch. Each instance has its own
 * call counter so tool_call → text_answer flow works independently per branch.
 */
function branchModelFactory(answer: string): () => Model {
  return () => {
    let calls = 0;
    return {
      providerId: "mock/branch-test",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        calls++;
        if (calls === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              type: "tool_use",
              id: `c-${calls}`,
              name: "echo",
              input: { msg: `hello-${answer}` },
            },
          };
        } else {
          yield { type: "text_delta", delta: `answer-${answer}-t${opts?.temperature ?? "?"}` };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
  };
}

function baseAgentOpts(factory: () => Model) {
  return { model: factory(), tools: [echoTool], maxSteps: 5 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RolloutForkRunner", () => {
  test("produces exactly N branch results", async () => {
    const factory = branchModelFactory("x");
    const runner = new RolloutForkRunner({ branches: 5, concurrency: 5, modelFactory: factory });
    const results = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      results.push(r);
    }
    expect(results).toHaveLength(5);
  });

  test("branch indices are 0..N-1", async () => {
    const factory = branchModelFactory("y");
    const runner = new RolloutForkRunner({ branches: 3, concurrency: 3, modelFactory: factory });
    const indices: number[] = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      indices.push(r.branchIndex);
    }
    expect(indices.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  test("each branch gets a unique sessionId", async () => {
    const factory = branchModelFactory("z");
    const runner = new RolloutForkRunner({ branches: 4, concurrency: 4, modelFactory: factory });
    const ids: string[] = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      ids.push(r.sessionId);
    }
    expect(new Set(ids).size).toBe(4);
  });

  test("all branches share the same rolloutId when provided", async () => {
    const factory = branchModelFactory("q");
    const runner = new RolloutForkRunner({ branches: 3, concurrency: 3, modelFactory: factory });
    const rids: string[] = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task", "fixed-id")) {
      rids.push(r.rolloutId);
    }
    expect(new Set(rids).size).toBe(1);
    expect(rids[0]).toBe("fixed-id");
  });

  test("trajectories contain tool_call and tool_result events", async () => {
    const factory = branchModelFactory("t");
    const runner = new RolloutForkRunner({ branches: 2, concurrency: 2, modelFactory: factory });
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      const types = r.trajectory.map((e) => e.event);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
    }
  });

  test("toolCallSequence contains only tool_call and tool_result events", async () => {
    const factory = branchModelFactory("s");
    const runner = new RolloutForkRunner({ branches: 2, concurrency: 2, modelFactory: factory });
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      for (const e of r.toolCallSequence) {
        expect(["tool_call", "tool_result"]).toContain(e.event);
      }
    }
  });

  test("temperature is passed per branch via temperaturePerBranch", async () => {
    const capturedTemps: number[] = [];
    const captureFactory = (): Model => ({
      providerId: "mock",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        if (opts?.temperature !== undefined) capturedTemps.push(opts.temperature);
        yield { type: "text_delta", delta: "done" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    });

    const runner = new RolloutForkRunner({
      branches: 3,
      concurrency: 3,
      modelFactory: captureFactory,
      temperaturePerBranch: [0.3, 0.6, 0.9],
    });
    const results = [];
    for await (const r of runner.run(baseAgentOpts(captureFactory), "task")) {
      results.push(r);
    }
    const branchTemps = results
      .sort((a, b) => a.branchIndex - b.branchIndex)
      .map((r) => r.temperature);
    expect(branchTemps).toEqual([0.3, 0.6, 0.9]);
  });

  test("finalAnswer is populated from final_answer event", async () => {
    const factory = branchModelFactory("abc");
    const runner = new RolloutForkRunner({ branches: 1, modelFactory: factory });
    const results = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      results.push(r);
    }
    expect(results[0]!.finalAnswer).toContain("answer-abc");
  });

  test("buildResult is always null (filled externally)", async () => {
    const factory = branchModelFactory("n");
    const runner = new RolloutForkRunner({ branches: 2, concurrency: 2, modelFactory: factory });
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      expect(r.buildResult).toBeNull();
    }
  });

  test("N=5 branches all produce results with tool call sequences", async () => {
    const factory = branchModelFactory("five");
    const runner = new RolloutForkRunner({
      branches: 5,
      concurrency: 5,
      modelFactory: factory,
      temperaturePerBranch: [0.1, 0.3, 0.5, 0.7, 0.9],
    });
    const results = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      results.push(r);
    }
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.toolCallSequence.length).toBeGreaterThan(0);
    }
  });

  test("seed is null when seedPerBranch is not provided", async () => {
    const factory = branchModelFactory("seed-none");
    const runner = new RolloutForkRunner({ branches: 2, concurrency: 2, modelFactory: factory });
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      expect(r.seed).toBeNull();
    }
  });

  test("seedPerBranch is stored in each branch result", async () => {
    const factory = branchModelFactory("seed-set");
    const runner = new RolloutForkRunner({
      branches: 3,
      concurrency: 3,
      modelFactory: factory,
      seedPerBranch: [100, 200, 300],
    });
    const results = [];
    for await (const r of runner.run(baseAgentOpts(factory), "task")) {
      results.push(r);
    }
    const seeds = results.sort((a, b) => a.branchIndex - b.branchIndex).map((r) => r.seed);
    expect(seeds).toEqual([100, 200, 300]);
  });

  test("memoryStore injection prepends successful past approaches to system prompt", async () => {
    const capturedPrompts: (string | undefined)[] = [];
    const memCapture = (): Model => ({
      providerId: "mock/mem",
      async *generate(msgs, opts): AsyncGenerator<StreamEvent> {
        const sys = msgs.find((m) => m.role === "system");
        capturedPrompts.push(typeof sys?.content === "string" ? sys.content : undefined);
        yield { type: "text_delta", delta: `done-t${opts?.temperature ?? "?"}` };
        yield { type: "stop", stopReason: "end_turn" };
      },
    });

    // Build a memory store with one stored approach
    const stored = new Map<string, { text: string; metadata?: Record<string, unknown> }>();
    const retriever: Retriever = {
      async add(id, text, metadata) {
        stored.set(id, { text, metadata });
      },
      async search(_query, topK = 3): Promise<SearchResult[]> {
        return [...stored.entries()].slice(0, topK).map(([id, { text, metadata }]) => ({
          id,
          text,
          score: 0.9,
          metadata,
        }));
      },
    };
    const mem = new RolloutMemoryStore({ store: retriever });
    await mem.upsert({
      rolloutId: "past-r1",
      branchIndex: 0,
      task: "build REST API",
      keySteps: "create_file → run_tests",
      objectiveScore: 1,
      finalAnswer: "done",
    });

    const runner = new RolloutForkRunner({
      branches: 1,
      modelFactory: memCapture,
      memoryStore: mem,
      memoryTopK: 1,
    });

    for await (const _ of runner.run(baseAgentOpts(memCapture), "build REST API")) {
      // drain
    }

    // The system prompt for each branch should contain the memory injection header
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const firstPrompt = capturedPrompts[0];
    expect(firstPrompt).toBeDefined();
    expect(firstPrompt).toContain("# Relevant past successful approaches:");
    expect(firstPrompt).toContain("REST API");
  });

  test("no memory injection when memoryStore is not provided", async () => {
    const capturedPrompts: (string | undefined)[] = [];
    const capture = (): Model => ({
      providerId: "mock/nomem",
      async *generate(msgs, opts): AsyncGenerator<StreamEvent> {
        const sys = msgs.find((m) => m.role === "system");
        capturedPrompts.push(typeof sys?.content === "string" ? sys.content : undefined);
        yield { type: "text_delta", delta: `done-t${opts?.temperature ?? "?"}` };
        yield { type: "stop", stopReason: "end_turn" };
      },
    });

    const runner = new RolloutForkRunner({ branches: 1, modelFactory: capture });
    for await (const _ of runner.run(baseAgentOpts(capture), "task")) {
      // drain
    }

    // No memory header injected
    for (const p of capturedPrompts) {
      if (p !== undefined) {
        expect(p).not.toContain("# Relevant past successful approaches:");
      }
    }
  });
});
