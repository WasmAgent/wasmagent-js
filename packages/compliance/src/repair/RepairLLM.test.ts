import { describe, expect, test } from "bun:test";
import { FakeRepairLLM } from "./RepairLLM.js";

describe("FakeRepairLLM", () => {
  test("returns the first matching rule's reply", async () => {
    const llm = new FakeRepairLLM([
      { match: (p) => p.includes("foo"), reply: "FOO" },
      { match: (p) => p.includes("bar"), reply: "BAR" },
    ]);
    const r = await llm.complete({ prompt: "please bar this" });
    expect(r.text).toBe("BAR");
  });

  test("calls reply as a function when it is a function", async () => {
    const llm = new FakeRepairLLM([{ match: () => true, reply: (p) => `echo:${p}` }]);
    const r = await llm.complete({ prompt: "hello" });
    expect(r.text).toBe("echo:hello");
  });

  test("throws when no rule matches — loud, not silent", async () => {
    const llm = new FakeRepairLLM([{ match: (p) => p === "x", reply: "y" }]);
    await expect(llm.complete({ prompt: "z" })).rejects.toThrow(/no matching rule/);
  });

  test("records every call into .calls", async () => {
    const llm = new FakeRepairLLM([{ match: () => true, reply: "ok" }]);
    await llm.complete({ prompt: "a" });
    await llm.complete({ prompt: "b", temperature: 0.1 });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.temperature).toBe(0.1);
  });

  test("passes through usage when the rule sets it", async () => {
    const llm = new FakeRepairLLM([
      {
        match: () => true,
        reply: "ok",
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ]);
    const r = await llm.complete({ prompt: "x" });
    expect(r.usage?.prompt_tokens).toBe(10);
  });

  test("push adds rules at runtime", async () => {
    const llm = new FakeRepairLLM();
    llm.push({ match: () => true, reply: "added" });
    const r = await llm.complete({ prompt: "x" });
    expect(r.text).toBe("added");
  });
});
