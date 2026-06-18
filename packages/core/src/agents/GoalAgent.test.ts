/**
 * Tests for GoalAgent — declarative goal-loop wrapping ToolCallingAgent.
 *
 * All tests use mock Models — no real LLM calls. The mocks return
 * scripted text and usage events, and we verify the goal-loop
 * structural behaviour:
 *
 *   - verify() pre-check terminates with iterationCount=0 if goal
 *     is already satisfied
 *   - verify() throws → outcome:"error" + clean shutdown
 *   - maxIterations bound respected → outcome:"exhausted"
 *   - tokenBudget triggers mid-loop termination → outcome:"budget"
 *   - verify() returns ok:true after iteration N → outcome:"verified",
 *     iterationCount=N
 *   - hint from prior verify failure feeds into next iteration's prompt
 *   - synthetic events (goal_iteration_start / goal_done) wrap the
 *     underlying ToolCallingAgent events
 */

import type { Model, StreamEvent } from "../models/types.js";
import { GoalAgent } from "./GoalAgent.js";

/**
 * Mock model that emits a fixed text answer and a fixed usage tally.
 * No tool calls — the goal-loop iteration ends with final_answer
 * (the cleanest path for testing).
 */
function textAnswerModel(answer: string, inputTokens = 100, outputTokens = 50): Model {
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: answer };
      yield { type: "usage", usage: { inputTokens, outputTokens } };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

/** Build a verify() that flips ok:true after N calls. */
function verifyAfter(n: number, hint = "not yet") {
  let calls = 0;
  return async () => {
    calls++;
    if (calls > n) return { ok: true } as const;
    return { ok: false, hint } as const;
  };
}

describe("GoalAgent — pre-loop check", () => {
  it("terminates with iterationCount=0 when verify() passes immediately", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("ok"),
      tools: [],
      maxIterations: 3,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: async () => ({ ok: true }) as const,
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: {
        outcome: string;
        iterationCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      };
    };
    expect(done).toBeDefined();
    expect(done.data.outcome).toBe("verified");
    expect(done.data.iterationCount).toBe(0);
    expect(done.data.totalInputTokens).toBe(0);
    expect(done.data.totalOutputTokens).toBe(0);
  });

  it("treats a verify() throw before iteration 1 as outcome:error", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("ok"),
      tools: [],
      maxIterations: 3,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: async () => {
        throw new Error("verifier broke");
      },
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number; lastError?: string };
    };
    expect(done.data.outcome).toBe("error");
    expect(done.data.lastError).toContain("verifier broke");
    expect(done.data.iterationCount).toBe(0);
  });
});

describe("GoalAgent — iteration loop", () => {
  it("yields goal_iteration_start before each iteration's TCA events", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("attempted"),
      tools: [],
      maxIterations: 3,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: verifyAfter(2),
    })) {
      events.push(ev);
    }
    const iterStarts = events.filter(
      (e) => (e as { event?: string }).event === "goal_iteration_start"
    ) as Array<{ data: { iteration: number; hint?: string } }>;
    expect(iterStarts.length).toBe(2); // verify passes after iter 2
    expect(iterStarts[0]?.data.iteration).toBe(1);
    expect(iterStarts[1]?.data.iteration).toBe(2);
  });

  it("verify ok:true after iteration N → outcome:verified, iterationCount=N", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("attempted"),
      tools: [],
      maxIterations: 5,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: verifyAfter(3),
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number };
    };
    expect(done.data.outcome).toBe("verified");
    expect(done.data.iterationCount).toBe(3);
  });

  it("hits maxIterations → outcome:exhausted", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("attempted"),
      tools: [],
      maxIterations: 2,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: async () => ({ ok: false, hint: "still failing" }) as const,
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number; lastHint?: string };
    };
    expect(done.data.outcome).toBe("exhausted");
    expect(done.data.iterationCount).toBe(2);
    expect(done.data.lastHint).toBe("still failing");
  });

  it("propagates verify() hint into next iteration's start event", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("x"),
      tools: [],
      maxIterations: 3,
    });
    let verifyCalls = 0;
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: async () => {
        verifyCalls++;
        // call 1 is the pre-loop check (sets initial hint)
        if (verifyCalls === 1) return { ok: false, hint: "pre-loop hint" } as const;
        // call 2 is verify after iteration 1
        if (verifyCalls === 2) return { ok: false, hint: "after-iter-1 hint" } as const;
        // call 3 is verify after iteration 2 — passes
        return { ok: true } as const;
      },
    })) {
      events.push(ev);
    }
    const iterStarts = events.filter(
      (e) => (e as { event?: string }).event === "goal_iteration_start"
    ) as Array<{ data: { iteration: number; hint?: string } }>;
    // iter 1 has the pre-loop hint
    expect(iterStarts[0]?.data.hint).toBe("pre-loop hint");
    // iter 2 has the after-iter-1 hint
    expect(iterStarts[1]?.data.hint).toBe("after-iter-1 hint");
  });

  it("captures token usage across iterations", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("x", 80, 40),
      tools: [],
      maxIterations: 3,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: verifyAfter(3),
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { totalInputTokens: number; totalOutputTokens: number };
    };
    expect(done.data.totalInputTokens).toBe(240);
    expect(done.data.totalOutputTokens).toBe(120);
  });
});

describe("GoalAgent — budget", () => {
  it("tokenBudget exhausted → outcome:budget", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("x", 100, 50),
      tools: [],
      maxIterations: 10,
      tokenBudget: 200,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: async () => ({ ok: false, hint: "incomplete" }) as const,
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: {
        outcome: string;
        iterationCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      };
    };
    expect(done.data.outcome).toBe("budget");
    expect(done.data.iterationCount).toBe(2);
    expect(done.data.totalInputTokens + done.data.totalOutputTokens).toBeGreaterThanOrEqual(200);
  });

  it("undefined tokenBudget = no budget cap", async () => {
    const agent = new GoalAgent({
      model: textAnswerModel("x", 1000, 1000),
      tools: [],
      maxIterations: 2,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "stub goal",
      verify: async () => ({ ok: false }) as const,
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number };
    };
    expect(done.data.outcome).toBe("exhausted");
    expect(done.data.iterationCount).toBe(2);
  });
});

describe("GoalAgent — iteration prompt construction", () => {
  it("first iteration prompt is goal.describe verbatim", async () => {
    const promptsSeen: string[] = [];
    const model: Model = {
      providerId: "mock/test",
      async *generate(messages): AsyncGenerator<StreamEvent> {
        const user = [...messages].reverse().find((m) => m.role === "user");
        if (user) promptsSeen.push(typeof user.content === "string" ? user.content : "");
        yield { type: "text_delta", delta: "ok" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new GoalAgent({ model, tools: [], maxIterations: 3 });
    for await (const _ of agent.run({
      describe: "Make tests pass",
      verify: verifyAfter(3),
    })) {
      // drain
    }
    expect(promptsSeen.length).toBeGreaterThanOrEqual(3);
    expect(promptsSeen[0]).toBe("Make tests pass");
    expect(promptsSeen[1]).toContain("Make tests pass");
    expect(promptsSeen[1]).toContain("Iteration 2");
    expect(promptsSeen[1]).toContain("not yet");
  });

  it("systemPromptAddendum is injected after the default goal system prompt", async () => {
    const sysPromptsSeen: string[] = [];
    const model: Model = {
      providerId: "mock/test",
      async *generate(messages): AsyncGenerator<StreamEvent> {
        const sys = messages.find((m) => m.role === "system");
        if (sys) sysPromptsSeen.push(typeof sys.content === "string" ? sys.content : "");
        yield { type: "text_delta", delta: "ok" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new GoalAgent({
      model,
      tools: [],
      maxIterations: 1,
      systemPromptAddendum: "Project rule: prefer TypeScript over JavaScript.",
    });
    for await (const _ of agent.run({
      describe: "x",
      verify: verifyAfter(1),
    })) {
      // drain
    }
    expect(sysPromptsSeen[0]).toContain("goal-directed assistant");
    expect(sysPromptsSeen[0]).toContain("Project rule: prefer TypeScript");
  });
});

describe("GoalAgent — error handling", () => {
  it("verify() throw mid-loop → outcome:error, iteration counted", async () => {
    let verifyCalls = 0;
    const agent = new GoalAgent({
      model: textAnswerModel("x"),
      tools: [],
      maxIterations: 5,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({
      describe: "x",
      verify: async () => {
        verifyCalls++;
        // call 1: pre-loop check (sets hint, doesn't pass)
        if (verifyCalls === 1) return { ok: false, hint: "try again" } as const;
        // call 2: verify after iteration 1 — throws
        if (verifyCalls === 2) throw new Error("verifier crashed");
        return { ok: true } as const;
      },
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number; lastError?: string };
    };
    expect(done.data.outcome).toBe("error");
    expect(done.data.iterationCount).toBe(1);
    expect(done.data.lastError).toContain("verifier crashed");
  });
});

// ── 2026-06-18 (axis 9, stop-loss) ─────────────────────────────────────────
describe("GoalAgent — repeat-hint early stop", () => {
  it("bails after maxNoProgressIterations consecutive byte-identical hints", async () => {
    // Verifier always returns the same hint string. With
    // maxNoProgressIterations: 2, the loop should hit iter 1 (set
    // baseline hint), iter 2 (streak=1, still under cap), iter 3
    // (streak=2 → bail). Total iterations = 3, not maxIterations.
    let calls = 0;
    const stuckVerify = async () => {
      calls++;
      return { ok: false, hint: "STUCK_HINT" };
    };
    const agent = new GoalAgent({
      model: textAnswerModel("retry"),
      tools: [],
      maxIterations: 10,
      maxNoProgressIterations: 2,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({ describe: "stub", verify: stuckVerify })) {
      events.push(ev);
    }
    expect(calls).toBe(3); // pre-loop (1) + iter1 (2) + iter2 (3) before bail
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number; lastHint?: string };
    };
    expect(done.data.outcome).toBe("exhausted");
    expect(done.data.iterationCount).toBe(2); // bailed during iter 2's verify check
    expect(done.data.lastHint).toBe("STUCK_HINT");
  });

  it("hint change resets the streak so productive iterations are not penalised", async () => {
    // Verifier returns a different hint each iteration → streak never
    // builds → loop runs to maxIterations naturally.
    let calls = 0;
    const movingVerify = async () => {
      calls++;
      return { ok: false, hint: `iter-${calls}-different-hint` };
    };
    const agent = new GoalAgent({
      model: textAnswerModel("retry"),
      tools: [],
      maxIterations: 5,
      maxNoProgressIterations: 2,
    });
    const events: unknown[] = [];
    for await (const ev of agent.run({ describe: "stub", verify: movingVerify })) {
      events.push(ev);
    }
    expect(calls).toBe(6); // pre-loop (1) + 5 iter verifies = 6
    const done = events.find((e) => (e as { event?: string }).event === "goal_done") as {
      data: { outcome: string; iterationCount: number };
    };
    expect(done.data.outcome).toBe("exhausted");
    expect(done.data.iterationCount).toBe(5);
  });

  it("default (no option set) preserves pre-2026-06-18 behaviour: no early stop", async () => {
    // Backwards-compat guard: GoalAgent direct callers must not see new
    // behaviour without opting in. The high-level GoalDirectedAgent
    // overrides the default; this test pins the LOWER layer to legacy.
    let calls = 0;
    const stuckVerify = async () => {
      calls++;
      return { ok: false, hint: "STUCK_HINT" };
    };
    const agent = new GoalAgent({
      model: textAnswerModel("retry"),
      tools: [],
      maxIterations: 3,
      // maxNoProgressIterations intentionally unset
    });
    for await (const _ of agent.run({ describe: "stub", verify: stuckVerify })) void _;
    expect(calls).toBe(4); // pre-loop (1) + 3 iter verifies = 4, no early stop
  });
});
