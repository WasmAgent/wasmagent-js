/**
 * Tests for MemoryBlocks: container ops, render shape, tool surface,
 * MessageAssembler integration (verifies blocks land in build() output
 * AFTER the cached system message and BEFORE history, without
 * invalidating the system prefix cache).
 */

import { describe, expect, it } from "vitest";
import { coreMemoryTools, MemoryBlockSet } from "./MemoryBlocks.js";
import { MessageAssembler } from "./MessageAssembler.js";

describe("MemoryBlockSet — container ops", () => {
  it("installs initial blocks and lists them in insertion order", () => {
    const blocks = new MemoryBlockSet([
      { label: "persona", value: "I am an assistant." },
      { label: "human", value: "User is named Teller." },
    ]);
    expect(blocks.size).toBe(2);
    expect(blocks.list().map((b) => b.label)).toEqual(["persona", "human"]);
  });

  it("get() returns block by label, undefined for unknown", () => {
    const blocks = new MemoryBlockSet([{ label: "p", value: "x" }]);
    expect(blocks.get("p")?.value).toBe("x");
    expect(blocks.get("nope")).toBeUndefined();
  });

  it("install() rejects an Nth new label when maxBlocks=N-1", () => {
    const blocks = new MemoryBlockSet(
      [
        { label: "a", value: "1" },
        { label: "b", value: "2" },
      ],
      { maxBlocks: 2 }
    );
    expect(() => blocks.install({ label: "c", value: "3" })).toThrow(/max 2 blocks reached/);
    // re-install of existing label is not bounded by maxBlocks
    blocks.install({ label: "a", value: "11" });
    expect(blocks.get("a")?.value).toBe("11");
  });

  it("install() rejects initial value over charLimit", () => {
    expect(
      () => new MemoryBlockSet([{ label: "p", value: "x".repeat(100), charLimit: 50 }])
    ).toThrow(/exceeds charLimit 50/);
  });

  it("append() succeeds when result fits, returns error when over", () => {
    const blocks = new MemoryBlockSet([{ label: "log", value: "hello", charLimit: 20 }]);
    expect(blocks.append("log", " world")).toEqual({ ok: true });
    expect(blocks.get("log")?.value).toBe("hello world");
    const r = blocks.append("log", " ".repeat(20));
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/exceed charLimit 20/);
    // value unchanged after rejected append
    expect(blocks.get("log")?.value).toBe("hello world");
  });

  it("append() errors when label is unknown", () => {
    const blocks = new MemoryBlockSet([{ label: "p", value: "x" }]);
    const r = blocks.append("missing", "y");
    expect(r).toEqual({ ok: false, error: "no block with label 'missing'" });
  });

  it("replace() overwrites and reports truncated:false when fitting", () => {
    const blocks = new MemoryBlockSet([{ label: "s", value: "old", charLimit: 100 }]);
    expect(blocks.replace("s", "new")).toEqual({ ok: true, truncated: false });
    expect(blocks.get("s")?.value).toBe("new");
  });

  it("replace() truncates from the LEFT when text is over charLimit (most-recent wins)", () => {
    const blocks = new MemoryBlockSet([{ label: "s", value: "", charLimit: 5 }]);
    const r = blocks.replace("s", "abcdefghij");
    expect(r).toEqual({ ok: true, truncated: true });
    // last 5 chars, not first 5
    expect(blocks.get("s")?.value).toBe("fghij");
  });

  it("replace() errors when label is unknown", () => {
    const blocks = new MemoryBlockSet();
    const r = blocks.replace("missing", "y");
    expect(r).toEqual({ ok: false, error: "no block with label 'missing'" });
  });
});

describe("MemoryBlockSet — render", () => {
  it("renders empty when no blocks", () => {
    expect(new MemoryBlockSet().render()).toBe("");
  });

  it("renders block label + value, wrapped in <core_memory> markers", () => {
    const blocks = new MemoryBlockSet([{ label: "persona", value: "I am an assistant." }]);
    const r = blocks.render();
    expect(r.startsWith("<core_memory>")).toBe(true);
    expect(r.endsWith("</core_memory>")).toBe(true);
    expect(r).toContain("[persona]");
    expect(r).toContain("I am an assistant.");
  });

  it("renders description in parens when present", () => {
    const blocks = new MemoryBlockSet([
      { label: "human", value: "Teller", description: "current user" },
    ]);
    expect(blocks.render()).toContain("[human] (current user)");
  });

  it("renders multiple blocks separated by blank lines (parseable boundaries)", () => {
    const blocks = new MemoryBlockSet([
      { label: "a", value: "v1" },
      { label: "b", value: "v2" },
    ]);
    const r = blocks.render();
    expect(r.indexOf("[a]")).toBeLessThan(r.indexOf("[b]"));
    // both values present
    expect(r).toContain("v1");
    expect(r).toContain("v2");
  });

  it("render output is deterministic across calls (no hidden state)", () => {
    const blocks = new MemoryBlockSet([{ label: "p", value: "stable" }]);
    expect(blocks.render()).toBe(blocks.render());
  });
});

describe("coreMemoryTools — agent-callable", () => {
  it("returns exactly two tools with Letta-compatible names", () => {
    const tools = coreMemoryTools(new MemoryBlockSet());
    expect(tools.map((t) => t.name)).toEqual(["core_memory_append", "core_memory_replace"]);
  });

  it("both tools are non-readOnly, non-idempotent (mutate state)", () => {
    const tools = coreMemoryTools(new MemoryBlockSet());
    for (const t of tools) {
      expect(t.readOnly).toBe(false);
      expect(t.idempotent).toBe(false);
    }
  });

  it("core_memory_append.forward() mutates the bound block set", async () => {
    const blocks = new MemoryBlockSet([{ label: "log", value: "" }]);
    const [appendTool] = coreMemoryTools(blocks);
    const r = (await appendTool!.forward({ label: "log", text: "hello" } as never)) as {
      ok: boolean;
      message: string;
    };
    expect(r.ok).toBe(true);
    expect(blocks.get("log")?.value).toBe("hello");
  });

  it("core_memory_append.forward() reports error message when label unknown", async () => {
    const blocks = new MemoryBlockSet();
    const [appendTool] = coreMemoryTools(blocks);
    const r = (await appendTool!.forward({ label: "nope", text: "x" } as never)) as {
      ok: boolean;
      message: string;
    };
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no block with label 'nope'");
  });

  it("core_memory_replace.forward() returns truncated:true when over limit", async () => {
    const blocks = new MemoryBlockSet([{ label: "s", value: "", charLimit: 3 }]);
    const [, replaceTool] = coreMemoryTools(blocks);
    const r = (await replaceTool!.forward({ label: "s", text: "abcdef" } as never)) as {
      ok: boolean;
      message: string;
      truncated: boolean;
    };
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(blocks.get("s")?.value).toBe("def");
  });
});

describe("MessageAssembler integration", () => {
  it("inserts memory blocks message AFTER system, BEFORE history (no blocks → no extra slot)", () => {
    const asm = new MessageAssembler({
      systemPrompt: "You are an agent.",
      toolsSchema: [],
    });
    const msgs = asm.build();
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe("system");
  });

  it("with blocks, the slot lands at index 1 (right after system)", () => {
    const blocks = new MemoryBlockSet([{ label: "persona", value: "I'm here." }]);
    const asm = new MessageAssembler({
      systemPrompt: "You are an agent.",
      toolsSchema: [],
      memoryBlocks: blocks,
    });
    const msgs = asm.build();
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("<core_memory>");
    expect(msgs[1]?.content).toContain("[persona]");
  });

  it("blocks slot does NOT appear when render() is empty (e.g. set is empty)", () => {
    const blocks = new MemoryBlockSet();
    const asm = new MessageAssembler({
      systemPrompt: "You are an agent.",
      toolsSchema: [],
      memoryBlocks: blocks,
    });
    expect(asm.build().length).toBe(1);
  });

  it("blocks slot updates when blocks mutate (no need to rebuild assembler)", () => {
    const blocks = new MemoryBlockSet([{ label: "p", value: "first" }]);
    const asm = new MessageAssembler({
      systemPrompt: "You are an agent.",
      toolsSchema: [],
      memoryBlocks: blocks,
    });
    const before = asm.build()[1]?.content;
    blocks.replace("p", "second");
    const after = asm.build()[1]?.content;
    expect(before).not.toEqual(after);
    expect(after).toContain("second");
    expect(after).not.toContain("first");
  });

  it("system message is byte-identical across builds even when blocks change (cache stability)", () => {
    const blocks = new MemoryBlockSet([{ label: "p", value: "v1" }]);
    const asm = new MessageAssembler({
      systemPrompt: "You are an agent.",
      toolsSchema: [{ name: "search", description: "search" }],
      memoryBlocks: blocks,
    });
    const sys1 = asm.build()[0];
    blocks.replace("p", "v2-different-content-entirely");
    blocks.append("p", "-and-more");
    const sys2 = asm.build()[0];
    // The system message itself MUST not have changed — that's the
    // entire point of rendering blocks separately. If this test fails,
    // we've regressed prompt-cache stability.
    expect(sys1?.content).toBe(sys2?.content);
    expect(sys1?.cacheBreakpoint).toEqual(sys2?.cacheBreakpoint);
  });

  it("blocks slot composes correctly with scratchpad — both render, blocks first", () => {
    const blocks = new MemoryBlockSet([{ label: "p", value: "block" }]);
    const asm = new MessageAssembler({
      systemPrompt: "You are an agent.",
      toolsSchema: [],
      memoryBlocks: blocks,
    });
    asm.setScratchpad("scratchpad text");
    const msgs = asm.build();
    expect(msgs.length).toBe(3);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.content).toContain("<core_memory>");
    expect(msgs[2]?.content).toContain("<scratchpad>");
  });
});
