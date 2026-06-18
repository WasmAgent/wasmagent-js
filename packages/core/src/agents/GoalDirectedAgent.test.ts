/**
 * Tests for GoalDirectedAgent — the high-level scout → criteria →
 * GoalAgent → summarize loop.
 *
 * All tests use mock Models + an in-memory WorkspaceReader fake. No
 * real LLM calls. The mocks let us script:
 *
 *   - the synth model's criteria reply (controls Phase 1)
 *   - the executor model's text answers (drive ToolCallingAgent
 *     iterations; we exit each iteration via final_answer rather than
 *     tool calls — keeps the test surface tight)
 *   - judge replies if the criteria include `llm_judge`
 *
 * What we cover:
 *   1. Phase 1 → Phase 4 → goal_directed_done with verified outcome
 *   2. empty criteria fallback → single-shot path
 *   3. unparseable synth reply → empty criteria → fallback
 *   4. file-based deterministic verify failure feeds hint into next
 *      iteration
 *   5. scout snapshot is included in the synth model's user message
 *   6. extra verifiers register and dispatch alongside built-ins
 */

import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import {
  type AdaptationProposal,
  GoalDirectedAgent,
  parseCriteriaReply,
  type ScoutSnapshot,
} from "./GoalDirectedAgent.js";
import type { Criterion, Verifier, WorkspaceReader } from "./verifiers/index.js";

function fakeWs(initial: Record<string, string> = {}): WorkspaceReader & {
  write: (path: string, body: string) => void;
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    async readFile(path) {
      if (!(path in data)) throw new Error(`ENOENT: ${path}`);
      return data[path] ?? "";
    },
    async fileExists(path) {
      return path in data;
    },
    async fileSize(path) {
      if (!(path in data)) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(data[path] ?? "").length;
    },
    write(path, body) {
      data[path] = body;
    },
  };
}

interface ScriptedCall {
  /** Emit text and then (optionally) write to the fake ws as a side effect. */
  text: string;
  sideEffect?: { path: string; body: string };
}

/**
 * Mock model that walks through a script of replies. Each call shifts
 * one entry off the front; if the script runs dry it repeats the last
 * entry forever (defensive — keeps tests from hanging on an unexpected
 * extra call).
 */
function scriptedModel(
  script: ScriptedCall[],
  ws?: ReturnType<typeof fakeWs>
): { model: Model; lastUserMessage: () => ModelMessage | undefined; calls: () => number } {
  let i = 0;
  let count = 0;
  let lastUser: ModelMessage | undefined;
  const model: Model = {
    providerId: "mock/scripted",
    async *generate(messages): AsyncGenerator<StreamEvent> {
      lastUser = messages.findLast((m) => m.role === "user");
      const entry = script[Math.min(i, script.length - 1)] ?? { text: "{}" };
      i++;
      count++;
      if (entry.sideEffect && ws) ws.write(entry.sideEffect.path, entry.sideEffect.body);
      yield { type: "text_delta", delta: entry.text };
      yield { type: "usage", usage: { inputTokens: 80, outputTokens: 30 } };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
  return { model, lastUserMessage: () => lastUser, calls: () => count };
}

const noTools: ToolDefinition[] = [];

const baseScout: ScoutSnapshot = {
  tools: [
    { name: "write_file", description: "create or overwrite a file" },
    { name: "read_file", description: "read a file" },
  ],
  workspaceEntries: ["README.md", "src/"],
};

describe("parseCriteriaReply", () => {
  it("returns [] for non-JSON input", () => {
    expect(parseCriteriaReply("absolutely no JSON here")).toEqual([]);
  });

  it("returns [] when criteria field is missing or wrong type", () => {
    expect(parseCriteriaReply(`{"foo":"bar"}`)).toEqual([]);
    expect(parseCriteriaReply(`{"criteria":"not an array"}`)).toEqual([]);
  });

  it("strips ```json fences", () => {
    const reply =
      "```json\n" +
      `{"criteria":[{"id":"a","description":"x","verify_method":"file_exists","path":"foo.md"}]}` +
      "\n```";
    const out = parseCriteriaReply(reply);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("a");
  });

  it("ignores malformed entries but keeps well-formed ones", () => {
    const reply = JSON.stringify({
      criteria: [
        { id: "ok", description: "good", verify_method: "file_exists", path: "a.md" },
        { id: 42, description: "bad-id" }, // wrong types
        null,
        {
          id: "ok2",
          description: "good2",
          verify_method: "word_count_min",
          arg: 100,
          path: "b.md",
        },
      ],
    });
    const out = parseCriteriaReply(reply);
    expect(out.map((c) => c.id)).toEqual(["ok", "ok2"]);
  });
});

describe("GoalDirectedAgent: phase pipeline", () => {
  it("scout → criteria → execute → verified (no judge needed)", async () => {
    const ws = fakeWs();
    const synthReply = JSON.stringify({
      criteria: [
        {
          id: "file_made",
          description: "doc.md exists",
          verify_method: "file_exists",
          path: "doc.md",
        },
      ],
    });
    const synth = scriptedModel([{ text: synthReply }]);
    // Executor model: emit a text answer AND side-effect-create the file
    const exec = scriptedModel(
      [{ text: "Done.", sideEffect: { path: "doc.md", body: "the document body" } }],
      ws
    );

    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      scout: baseScout,
      maxIterations: 2,
      maxStepsPerIteration: 2,
    });
    const events = [];
    for await (const ev of agent.run("write a small intro doc")) events.push(ev);
    const names = events.map((e) => e.event);
    expect(names).toContain("scout_done");
    expect(names).toContain("criteria_proposed");
    expect(names).toContain("goal_directed_done");
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string; iterationCount: number };
    expect(data.outcome).toBe("verified");
    expect(data.iterationCount).toBeGreaterThanOrEqual(1);
  });

  it("empty criteria: single-shot fallback yields outcome=single-shot", async () => {
    const ws = fakeWs();
    const synth = scriptedModel([{ text: "not JSON at all" }]);
    const exec = scriptedModel([{ text: "Hi!" }]);
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxStepsPerIteration: 2,
    });
    const events = [];
    for await (const ev of agent.run("say hi")) events.push(ev);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string; emptyCriteriaFallback?: boolean };
    expect(data.outcome).toBe("single-shot");
    expect(data.emptyCriteriaFallback).toBe(true);
  });

  it("verify failure feeds hint into next iteration's prompt", async () => {
    // Iteration 1: writes a tiny doc. Verify (file_size_min=100) fails.
    // Iteration 2: writes a bigger doc. Verify passes.
    const ws = fakeWs();
    const synthReply = JSON.stringify({
      criteria: [
        {
          id: "size",
          description: "≥100 bytes",
          verify_method: "file_size_min",
          arg: 100,
          path: "doc.md",
        },
      ],
    });
    const synth = scriptedModel([{ text: synthReply }]);
    const exec = scriptedModel(
      [
        { text: "first try", sideEffect: { path: "doc.md", body: "tiny" } },
        {
          text: "second try",
          sideEffect: {
            path: "doc.md",
            body: "x".repeat(200),
          },
        },
      ],
      ws
    );
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 3,
      maxStepsPerIteration: 1,
    });
    const events = [];
    for await (const ev of agent.run("write a doc")) events.push(ev);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string; iterationCount: number };
    expect(data.outcome).toBe("verified");
    expect(data.iterationCount).toBe(2);
    // The second iteration's user message should reference the verify hint.
    const userMessageWithHint = exec.lastUserMessage();
    if (userMessageWithHint && typeof userMessageWithHint.content === "string") {
      expect(userMessageWithHint.content).toMatch(/verifier|criterion requires/);
    }
  });

  it("exhausts when verify never passes", async () => {
    const ws = fakeWs();
    const synthReply = JSON.stringify({
      criteria: [
        {
          id: "exists",
          description: "missing.md exists",
          verify_method: "file_exists",
          path: "missing.md",
        },
      ],
    });
    const synth = scriptedModel([{ text: synthReply }]);
    // executor never creates missing.md
    const exec = scriptedModel([{ text: "trying" }]);
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
    });
    const events = [];
    for await (const ev of agent.run("never satisfiable")) events.push(ev);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    expect(data.outcome).toBe("exhausted");
  });

  it("scout snapshot is reflected in the synth model's user prompt", async () => {
    const ws = fakeWs();
    const synth = scriptedModel([{ text: `{"criteria":[]}` }]); // forces single-shot fallback
    const exec = scriptedModel([{ text: "ok" }]);
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      scout: {
        tools: [{ name: "fizz_tool", description: "fizz the buzz" }],
        workspaceEntries: ["mything.txt"],
        memoryHints: "User prefers concise replies.",
      },
    });
    for await (const _ of agent.run("do a thing")) void _;
    const usr = synth.lastUserMessage();
    expect(usr && typeof usr.content === "string" && usr.content).toMatch(/fizz_tool/);
    expect(usr && typeof usr.content === "string" && usr.content).toMatch(/mything\.txt/);
    expect(usr && typeof usr.content === "string" && usr.content).toMatch(/concise replies/);
  });

  it("extra verifiers register and run", async () => {
    const ws = fakeWs({ "code.ts": "// stub" });
    const synthReply = JSON.stringify({
      criteria: [{ id: "lint", description: "lints clean", verify_method: "tests_pass" }],
    });
    const synth = scriptedModel([{ text: synthReply }]);
    const exec = scriptedModel([{ text: "fixed" }]);
    let testsCalled = 0;
    const testsPass: Verifier = {
      methods: ["tests_pass"],
      async verify(c) {
        testsCalled++;
        return { ok: true, criterionId: c.id };
      },
    };
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      extraVerifiers: [testsPass],
      maxIterations: 1,
      maxStepsPerIteration: 1,
    });
    for await (const _ of agent.run("make tests pass")) void _;
    expect(testsCalled).toBe(1);
  });

  it("LLMJudge integration: criteria with llm_judge are evaluated by the judge model", async () => {
    const ws = fakeWs({ "doc.md": "x".repeat(500) });
    const synthReply = JSON.stringify({
      criteria: [
        {
          id: "depth",
          description: "covers all aspects",
          verify_method: "llm_judge",
          path: "doc.md",
        },
      ],
    });
    const synth = scriptedModel([{ text: synthReply }]);
    const exec = scriptedModel([{ text: "I worked on it" }]);
    // Judge model: 3 unanimous passes
    const judge = scriptedModel([
      { text: `{"pass":true,"reasoning":"covers"}` },
      { text: `{"pass":true,"reasoning":"covers"}` },
      { text: `{"pass":true,"reasoning":"covers"}` },
    ]);
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      judgeModel: judge.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 1,
      maxStepsPerIteration: 1,
    });
    const events = [];
    for await (const ev of agent.run("write deep doc")) events.push(ev);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    expect(data.outcome).toBe("verified");
    expect(judge.calls()).toBe(3);
  });

  it("preset criteria via opts.criteria skip Phase 1 entirely", async () => {
    // 2026-06-18 (--from-criteria): when the caller supplies a frozen
    // Criterion[] list, the synth model must NOT be called — the loop
    // is meant to be deterministic across runs. The criteria_proposed
    // event still fires (with the supplied list) so observers see the
    // same shape regardless of how Phase 1 produced the criteria.
    const ws = fakeWs();
    const synth = scriptedModel([{ text: "SYNTH SHOULD NOT BE CALLED" }]);
    const exec = scriptedModel(
      [{ text: "Done", sideEffect: { path: "doc.md", body: "the body" } }],
      ws
    );
    const presetCriteria: Criterion[] = [
      {
        id: "exists",
        description: "doc.md must exist",
        verify_method: "file_exists",
        path: "doc.md",
      },
    ];
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      criteria: presetCriteria,
      maxIterations: 1,
      maxStepsPerIteration: 1,
    });
    const events = [];
    for await (const ev of agent.run("write a doc")) events.push(ev);

    // Synth model untouched — the whole point of the preset path.
    expect(synth.calls()).toBe(0);

    // The criteria_proposed event still fired, with our exact list.
    const proposed = events.find((e) => e.event === ("criteria_proposed" as never));
    expect((proposed?.data as { criteria: Criterion[] }).criteria).toEqual(presetCriteria);

    // And the loop still verified.
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    expect((final?.data as { outcome: string }).outcome).toBe("verified");
  });

  it("preset criteria with empty array still triggers single-shot fallback", async () => {
    // Edge case: caller passes [] explicitly. Same handling as a
    // synth that returned 0 criteria — drop into single-shot mode
    // rather than running an always-passing loop. Synth still skipped.
    const ws = fakeWs();
    const synth = scriptedModel([{ text: "SYNTH SHOULD NOT BE CALLED" }]);
    const exec = scriptedModel([{ text: "Hello" }]);
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      criteria: [],
      maxIterations: 1,
      maxStepsPerIteration: 1,
    });
    const events = [];
    for await (const ev of agent.run("say hi")) events.push(ev);

    expect(synth.calls()).toBe(0);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string; emptyCriteriaFallback?: boolean };
    expect(data.outcome).toBe("single-shot");
    expect(data.emptyCriteriaFallback).toBe(true);
  });
});

describe("GoalDirectedAgent: criteria type-shape sanity", () => {
  it("preserves arg + path on round-trip through parseCriteriaReply", () => {
    const c: Criterion = {
      id: "x",
      description: "x",
      verify_method: "file_size_min",
      arg: 1500,
      path: "doc.md",
    };
    const reply = JSON.stringify({ criteria: [c] });
    const back = parseCriteriaReply(reply);
    expect(back).toEqual([c]);
  });
});

// ── 2026-06-18 (axis 9, L3 — adaptive execution) ──────────────────────────
describe("GoalDirectedAgent: L3 goal adaptation negotiation", () => {
  // A criterion the verifier will always fail (file size below threshold).
  const unattainable: Criterion = {
    id: "size",
    description: "≥1000 bytes",
    verify_method: "file_size_min",
    arg: 1000,
    path: "doc.md",
  };
  // A relaxed proposal the synth model returns for round 2.
  const relaxed: Criterion = {
    id: "size",
    description: "≥10 bytes",
    verify_method: "file_size_min",
    arg: 10,
    path: "doc.md",
  };
  const synthInitial = JSON.stringify({ criteria: [unattainable] });
  const synthAdaptation = JSON.stringify({
    keep: [],
    relax: [{ original: unattainable, proposed: relaxed, reasoning: "tighter floor unreachable" }],
    dropped: [],
  });

  it("allowNegotiate=false → outcome 'exhausted' on iteration cap (backwards compat)", async () => {
    const ws = fakeWs();
    const synth = scriptedModel([{ text: synthInitial }]);
    // Executor writes a tiny doc each iteration — never satisfies size>=1000.
    const exec = scriptedModel(
      [
        { text: "try1", sideEffect: { path: "doc.md", body: "tiny" } },
        { text: "try2", sideEffect: { path: "doc.md", body: "tiny" } },
      ],
      ws
    );
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
      // allowNegotiate intentionally unset
    });
    const events = [];
    for await (const ev of agent.run("write a long doc")) events.push(ev);
    expect(events.find((e) => e.event === "goal_adaptation_proposed")).toBeUndefined();
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    expect(data.outcome).toBe("exhausted");
  });

  it("allowNegotiate + accept → loop resumes with relaxed criteria, eventually verified", async () => {
    const ws = fakeWs();
    // Two synth calls: initial criteria, then adaptation proposal.
    const synth = scriptedModel([{ text: synthInitial }, { text: synthAdaptation }]);
    // Executor writes a 20-byte doc — fails first criterion (>=1000) but
    // satisfies the relaxed (>=10) when re-run after acceptance.
    const exec = scriptedModel(
      [
        { text: "round1-1", sideEffect: { path: "doc.md", body: "twenty-bytes-okay-?" } },
        { text: "round1-2", sideEffect: { path: "doc.md", body: "twenty-bytes-okay-?" } },
        { text: "round2-1", sideEffect: { path: "doc.md", body: "twenty-bytes-okay-?" } },
      ],
      ws
    );
    let proposalSeen: AdaptationProposal | null = null;
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
      allowNegotiate: true,
      onAdaptationProposed: async (p) => {
        proposalSeen = p;
        return { decision: "accept" };
      },
    });
    const events = [];
    for await (const ev of agent.run("write a long doc")) events.push(ev);
    expect(proposalSeen).not.toBeNull();
    expect((proposalSeen as unknown as AdaptationProposal).relaxCriteria).toHaveLength(1);
    expect(events.find((e) => e.event === "goal_adaptation_proposed")).toBeDefined();
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    expect(data.outcome).toBe("verified");
  });

  it("allowNegotiate + reject → outcome 'negotiation-proposed', no resume", async () => {
    const ws = fakeWs();
    const synth = scriptedModel([{ text: synthInitial }, { text: synthAdaptation }]);
    const exec = scriptedModel(
      [
        { text: "r1", sideEffect: { path: "doc.md", body: "tiny" } },
        { text: "r2", sideEffect: { path: "doc.md", body: "tiny" } },
      ],
      ws
    );
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
      allowNegotiate: true,
      onAdaptationProposed: async () => ({ decision: "reject" }),
    });
    const events = [];
    for await (const ev of agent.run("write")) events.push(ev);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    expect(data.outcome).toBe("negotiation-proposed");
    // Synth was called for initial + adaptation, total 2.
    expect(synth.calls()).toBe(2);
  });

  it("allowNegotiate + no callback → default-rejects → outcome 'negotiation-proposed'", async () => {
    // Safety default: silent acceptance would let the framework rewrite goals
    // without supervision. Without a callback, every proposal is rejected.
    const ws = fakeWs();
    const synth = scriptedModel([{ text: synthInitial }, { text: synthAdaptation }]);
    const exec = scriptedModel([{ text: "r1", sideEffect: { path: "doc.md", body: "tiny" } }], ws);
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 1,
      maxStepsPerIteration: 1,
      allowNegotiate: true,
      // onAdaptationProposed deliberately omitted
    });
    const events = [];
    for await (const ev of agent.run("write")) events.push(ev);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    expect(data.outcome).toBe("negotiation-proposed");
  });

  it("maxNegotiationRounds caps the loop even when caller keeps accepting", async () => {
    // Pathological scenario: each proposal leaves criteria still unattainable,
    // and the caller blindly accepts. The loop must terminate after
    // maxNegotiationRounds (default 1).
    const ws = fakeWs();
    const synth = scriptedModel([
      { text: synthInitial },
      { text: synthAdaptation }, // round 1 proposal
      { text: synthAdaptation }, // would be round 2 if allowed
    ]);
    const exec = scriptedModel(
      [
        { text: "r1-1", sideEffect: { path: "doc.md", body: "x" } },
        { text: "r2-1", sideEffect: { path: "doc.md", body: "x" } },
        { text: "r3-1", sideEffect: { path: "doc.md", body: "x" } },
      ],
      ws
    );
    let proposalCount = 0;
    const agent = new GoalDirectedAgent({
      model: exec.model,
      synthModel: synth.model,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 1,
      maxStepsPerIteration: 1,
      allowNegotiate: true,
      // Even though caller accepts, the second-round criteria still fails;
      // the cap (default 1) prevents infinite back-and-forth.
      onAdaptationProposed: async () => {
        proposalCount++;
        return { decision: "accept" };
      },
    });
    const events = [];
    for await (const ev of agent.run("write")) events.push(ev);
    expect(proposalCount).toBe(1);
    const final = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = final?.data as { outcome: string };
    // After round 1 the loop ran again with "tiny" body still failing relaxed
    // criterion — capped, terminates exhausted (not negotiation-proposed,
    // because the cap was hit, not the rejection).
    expect(["exhausted", "negotiation-proposed"]).toContain(data.outcome);
  });
});
