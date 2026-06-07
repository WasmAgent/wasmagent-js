import { describe, it, expect, beforeEach } from "vitest";
import { MessageAssembler } from "../memory/MessageAssembler.js";

function makeAction(stepIndex: number) {
  return { type: "action" as const, stepIndex, thoughts: `t${stepIndex}`, code: `c${stepIndex}`, observations: `o${stepIndex}` };
}

describe("MessageAssembler", () => {
  let assembler: MessageAssembler;

  beforeEach(() => {
    assembler = new MessageAssembler({
      systemPrompt: "You are a helpful assistant.",
      toolsSchema: [],
    });
  });

  it("build returns system message first", () => {
    const messages = assembler.build();
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("You are a helpful assistant.");
  });

  it("system message includes tools schema", () => {
    const withTools = new MessageAssembler({
      systemPrompt: "You are a helpful assistant.",
      toolsSchema: [{ name: "echo", description: "echoes" }],
    });
    const messages = withTools.build();
    const sys = messages[0];
    expect(typeof sys?.content === "string" && sys.content).toContain("<tools>");
    expect(typeof sys?.content === "string" && sys.content).toContain("echo");
  });

  it("system message has cache breakpoint (B1)", () => {
    const messages = assembler.build();
    expect(messages[0]?.cacheBreakpoint).toEqual({ afterBlockIndex: 0, type: "ephemeral" });
  });

  it("addStep: action step produces assistant + user message pair", () => {
    assembler.addStep({
      type: "action",
      stepIndex: 1,
      thoughts: "I should compute",
      code: "1+1",
      observations: "2",
    });
    const messages = assembler.build();
    // system + assistant + user
    expect(messages).toHaveLength(3);
    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(typeof assistant?.content === "string" && assistant.content).toContain("<thoughts>I should compute</thoughts>");
    const user = messages[2];
    expect(user?.role).toBe("user");
    expect(typeof user?.content === "string" && user.content).toContain("<observation>2</observation>");
  });

  it("addStep: planning step produces only assistant message", () => {
    assembler.addStep({
      type: "planning",
      plan: "Step 1: compute x",
      facts: "x is unknown",
    });
    const messages = assembler.build();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("assistant");
    expect(typeof messages[1]?.content === "string" && messages[1].content).toContain("<plan>");
  });

  it("addStep: final_answer step produces no messages", () => {
    assembler.addStep({ type: "final_answer", answer: 42 });
    const messages = assembler.build();
    expect(messages).toHaveLength(1); // only system
  });

  it("reset clears history", () => {
    assembler.addStep({
      type: "action",
      stepIndex: 1,
      thoughts: "",
      code: "",
      observations: "",
    });
    assembler.reset();
    expect(assembler.build()).toHaveLength(1); // only system
  });

  it("multiple steps accumulate in order", () => {
    assembler.addStep({ type: "action", stepIndex: 1, thoughts: "a", code: "a", observations: "oa" });
    assembler.addStep({ type: "action", stepIndex: 2, thoughts: "b", code: "b", observations: "ob" });
    const messages = assembler.build();
    // system + (assistant + user) * 2 = 5
    expect(messages).toHaveLength(5);
  });

  it("few-shot examples are included after system message", () => {
    const withFewShot = new MessageAssembler({
      systemPrompt: "You are a helpful assistant.",
      toolsSchema: [],
      fewShotExamples: [
        { role: "user", content: "example?" },
        { role: "assistant", content: "example answer" },
      ],
    });
    const messages = withFewShot.build();
    expect(messages).toHaveLength(3); // system + 2 few-shot
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("assistant");
  });

  describe("B2 segment caching", () => {
    it("no breakpoints on history when chunkSizeSteps not set", () => {
      assembler.addStep(makeAction(1));
      assembler.addStep(makeAction(2));
      assembler.addStep(makeAction(3));
      const messages = assembler.build();
      // Only the system message should have a cacheBreakpoint.
      const withBreakpoint = messages.filter((m) => m.cacheBreakpoint);
      expect(withBreakpoint).toHaveLength(1);
      expect(withBreakpoint[0]?.role).toBe("system");
    });

    it("seals a chunk boundary with a cache breakpoint (B2)", () => {
      const chunked = new MessageAssembler({
        systemPrompt: "p",
        toolsSchema: [],
        chunkSizeSteps: 2,
      });
      chunked.addStep(makeAction(1));
      chunked.addStep(makeAction(2)); // chunk boundary at step 2
      chunked.addStep(makeAction(3)); // tail — not sealed

      const messages = chunked.build();
      const withBreakpoint = messages.filter((m) => m.cacheBreakpoint);
      // system + last message of step 2's pair = 2 breakpoints
      expect(withBreakpoint).toHaveLength(2);
    });

    it("sealedChunkCount is 0 when chunkSizeSteps not set", () => {
      assembler.addStep(makeAction(1));
      assembler.addStep(makeAction(2));
      expect(assembler.sealedChunkCount).toBe(0);
    });

    it("sealedChunkCount increments at chunk boundaries", () => {
      const chunked = new MessageAssembler({
        systemPrompt: "p",
        toolsSchema: [],
        chunkSizeSteps: 3,
      });
      chunked.addStep(makeAction(1));
      expect(chunked.sealedChunkCount).toBe(0);
      chunked.addStep(makeAction(2));
      expect(chunked.sealedChunkCount).toBe(0);
      chunked.addStep(makeAction(3)); // first chunk sealed
      expect(chunked.sealedChunkCount).toBe(1);
      chunked.addStep(makeAction(4));
      expect(chunked.sealedChunkCount).toBe(1);
      chunked.addStep(makeAction(5));
      chunked.addStep(makeAction(6)); // second chunk sealed
      expect(chunked.sealedChunkCount).toBe(2);
    });

    it("two sealed chunks produce two additional breakpoints", () => {
      const chunked = new MessageAssembler({
        systemPrompt: "p",
        toolsSchema: [],
        chunkSizeSteps: 2,
      });
      for (let i = 1; i <= 5; i++) chunked.addStep(makeAction(i));
      // chunks: [1,2] [3,4] | tail: [5]
      const messages = chunked.build();
      const withBreakpoint = messages.filter((m) => m.cacheBreakpoint);
      // system + end of chunk1 + end of chunk2 = 3 breakpoints
      expect(withBreakpoint).toHaveLength(3);
    });
  });

  describe("ToolUseStep (multi-turn tool conversation)", () => {
    it("produces assistant[tool_use] + user[tool_result] message pair", () => {
      assembler.addStep({
        type: "tool_use",
        stepIndex: 1,
        thoughts: "I should call add",
        toolCallId: "call-1",
        toolName: "add",
        toolInput: { a: 3, b: 4 },
        toolOutput: "7",
        isError: false,
      });
      const messages = assembler.build();
      // system + assistant + user = 3
      expect(messages).toHaveLength(3);
      const assistant = messages[1];
      const user = messages[2];
      expect(assistant?.role).toBe("assistant");
      expect(Array.isArray(assistant?.content)).toBe(true);
      const assistantBlocks = assistant?.content as Array<{ type: string }>;
      expect(assistantBlocks.some((b) => b.type === "tool_use")).toBe(true);
      expect(assistantBlocks.some((b) => b.type === "text")).toBe(true);
      expect(user?.role).toBe("user");
      const userBlocks = user?.content as Array<{ type: string }>;
      expect(userBlocks[0]?.type).toBe("tool_result");
    });

    it("omits text block when thoughts is empty", () => {
      assembler.addStep({
        type: "tool_use",
        stepIndex: 1,
        thoughts: "",
        toolCallId: "call-2",
        toolName: "echo",
        toolInput: { message: "hi" },
        toolOutput: "hi",
        isError: false,
      });
      const messages = assembler.build();
      const assistant = messages[1];
      const blocks = assistant?.content as Array<{ type: string }>;
      expect(blocks.every((b) => b.type !== "text")).toBe(true);
      expect(blocks.some((b) => b.type === "tool_use")).toBe(true);
    });

    it("tool_use and tool_result carry correct ids and names", () => {
      assembler.addStep({
        type: "tool_use",
        stepIndex: 1,
        thoughts: "",
        toolCallId: "tc-abc",
        toolName: "search",
        toolInput: { query: "AI" },
        toolOutput: "results",
        isError: false,
      });
      const messages = assembler.build();
      const assistantBlocks = messages[1]?.content as unknown as Array<Record<string, unknown>>;
      const toolUseBlock = assistantBlocks.find((b) => b["type"] === "tool_use");
      expect(toolUseBlock?.["id"]).toBe("tc-abc");
      expect(toolUseBlock?.["name"]).toBe("search");

      const userBlocks = messages[2]?.content as unknown as Array<Record<string, unknown>>;
      expect(userBlocks[0]?.["toolUseId"]).toBe("tc-abc");
      expect(userBlocks[0]?.["content"]).toBe("results");
    });
  });

  describe("UserMessageStep (plain user turns)", () => {
    it("produces a single user message with the given content", () => {
      assembler.addStep({ type: "user_message", content: "Hello from user" });
      const messages = assembler.build();
      // system + user = 2
      expect(messages).toHaveLength(2);
      expect(messages[1]?.role).toBe("user");
      expect(messages[1]?.content).toBe("Hello from user");
    });

    it("does NOT produce a preceding assistant turn", () => {
      assembler.addStep({ type: "user_message", content: "Task text" });
      const messages = assembler.build();
      // Exactly system + user — no assistant turn first.
      expect(messages[0]?.role).toBe("system");
      expect(messages[1]?.role).toBe("user");
    });

    it("interleaves correctly with action steps", () => {
      assembler.addStep({ type: "user_message", content: "task" });
      assembler.addStep(makeAction(1));
      const messages = assembler.build();
      // system + user("task") + assistant(action) + user(observation) = 4
      expect(messages).toHaveLength(4);
      expect(messages[1]?.role).toBe("user");
      expect(messages[1]?.content).toBe("task");
      expect(messages[2]?.role).toBe("assistant");
      expect(messages[3]?.role).toBe("user");
    });

    it("multiple user_message steps each produce their own user turn", () => {
      assembler.addStep({ type: "user_message", content: "first" });
      assembler.addStep({ type: "user_message", content: "second" });
      const messages = assembler.build();
      // system + user + user = 3
      expect(messages).toHaveLength(3);
      expect(messages[1]?.content).toBe("first");
      expect(messages[2]?.content).toBe("second");
    });
  });

  describe("ParallelToolUseStep (multi-tool batch)", () => {
    it("produces one assistant message with N tool_use blocks + one user message with N tool_result blocks", () => {
      assembler.addStep({
        type: "parallel_tool_use",
        stepIndex: 1,
        thoughts: "calling two tools",
        calls: [
          { toolCallId: "t1", toolName: "search", toolInput: { q: "AI" }, toolOutput: "result1", isError: false },
          { toolCallId: "t2", toolName: "calc", toolInput: { expr: "2+2" }, toolOutput: "4", isError: false },
        ],
      });
      const messages = assembler.build();
      // system + assistant + user = 3
      expect(messages).toHaveLength(3);

      const assistant = messages[1];
      expect(assistant?.role).toBe("assistant");
      const aBlocks = assistant?.content as unknown as Array<Record<string, unknown>>;
      expect(aBlocks.some((b) => b["type"] === "text" && b["text"] === "calling two tools")).toBe(true);
      const toolUseBlocks = aBlocks.filter((b) => b["type"] === "tool_use");
      expect(toolUseBlocks).toHaveLength(2);
      expect(toolUseBlocks[0]?.["id"]).toBe("t1");
      expect(toolUseBlocks[1]?.["id"]).toBe("t2");

      const user = messages[2];
      expect(user?.role).toBe("user");
      const uBlocks = user?.content as unknown as Array<Record<string, unknown>>;
      const resultBlocks = uBlocks.filter((b) => b["type"] === "tool_result");
      expect(resultBlocks).toHaveLength(2);
      expect(resultBlocks[0]?.["toolUseId"]).toBe("t1");
      expect(resultBlocks[1]?.["toolUseId"]).toBe("t2");
    });

    it("omits text block when thoughts is empty", () => {
      assembler.addStep({
        type: "parallel_tool_use",
        stepIndex: 1,
        thoughts: "",
        calls: [
          { toolCallId: "t1", toolName: "fn", toolInput: {}, toolOutput: "ok", isError: false },
        ],
      });
      const messages = assembler.build();
      const aBlocks = messages[1]?.content as unknown as Array<Record<string, unknown>>;
      expect(aBlocks.every((b) => b["type"] !== "text")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // compact() tests (P4)
  // -------------------------------------------------------------------------
  describe("compact()", () => {
    function mockModel(summary: string): import("../models/types.js").Model {
      return {
        providerId: "mock/test",
        async *generate(): AsyncGenerator<import("../models/types.js").StreamEvent> {
          yield { type: "text_delta", delta: summary };
          yield { type: "stop", stopReason: "end_turn" };
        },
      };
    }

    it("returns 0 and does not mutate when history <= keepRecentSteps", async () => {
      const a = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
      a.addStep(makeAction(1));
      a.addStep(makeAction(2));
      const before = a.build().length;
      const compacted = await a.compact(mockModel("summary"), 5);
      expect(compacted).toBe(0);
      expect(a.build().length).toBe(before);
    });

    it("compacts older steps and keeps recent steps verbatim", async () => {
      const a = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
      for (let i = 1; i <= 8; i++) a.addStep(makeAction(i));
      // keepRecentSteps=3 → compact first 5 steps
      const compacted = await a.compact(mockModel("steps 1-5 summary"), 3);
      expect(compacted).toBe(5);
      // History should now have 1 summary step + 3 recent = 4 steps
      expect(a.historyLength).toBe(4);
    });

    it("summary text appears in built messages", async () => {
      const a = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
      for (let i = 1; i <= 6; i++) a.addStep(makeAction(i));
      await a.compact(mockModel("COMPACT_SUMMARY_MARKER"), 2);
      const messages = a.build();
      const allContent = messages.map((m) => JSON.stringify(m.content)).join(" ");
      expect(allContent).toContain("COMPACT_SUMMARY_MARKER");
    });

    it("reduces total message count after compaction", async () => {
      const a = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
      for (let i = 1; i <= 10; i++) a.addStep(makeAction(i));
      const before = a.build().length;
      await a.compact(mockModel("summary"), 3);
      const after = a.build().length;
      expect(after).toBeLessThan(before);
    });

    it("historyLength reflects post-compact state", async () => {
      const a = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
      for (let i = 1; i <= 7; i++) a.addStep(makeAction(i));
      expect(a.historyLength).toBe(7);
      await a.compact(mockModel("summary"), 3);
      // 1 summary step + 3 recent = 4
      expect(a.historyLength).toBe(4);
    });

    it("multiple compact() calls further reduce history", async () => {
      const a = new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
      for (let i = 1; i <= 10; i++) a.addStep(makeAction(i));
      await a.compact(mockModel("first summary"), 4);
      const midLength = a.historyLength;
      // Add more steps then compact again
      for (let i = 11; i <= 15; i++) a.addStep(makeAction(i));
      await a.compact(mockModel("second summary"), 2);
      expect(a.historyLength).toBeLessThan(midLength + 5);
    });
  });
});
