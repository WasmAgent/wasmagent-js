import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Scheduler, SimpleIR } from "../scheduler/index.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";

const doubleTool: ToolDefinition<{ value: number }, number> = {
  name: "double",
  description: "Doubles a number",
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ value }) => value * 2,
};

function makeRegistry(...tools: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe("Scheduler", () => {
  it("executes single node and emits node_start + node_done", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    const ir = new SimpleIR([
      { id: "n1", toolName: "double", args: { value: 5 }, dependsOn: [], readOnly: true, idempotent: true },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("node_start");
    expect(events[1]?.type).toBe("node_done");
    const result = events[1]?.result as { output: unknown };
    expect(result.output).toBe(10);
  });

  it("independent nodes run in parallel (both node_start before any node_done)", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    const ir = new SimpleIR([
      { id: "a", toolName: "double", args: { value: 1 }, dependsOn: [], readOnly: true, idempotent: true },
      { id: "b", toolName: "double", args: { value: 2 }, dependsOn: [], readOnly: true, idempotent: true },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);

    // Both starts are emitted before any done (wave-parallel semantics).
    const types = events.map((e) => e.type);
    expect(types).toEqual(["node_start", "node_start", "node_done", "node_done"]);

    // Both node IDs appear in starts and dones.
    const starts = events.filter((e) => e.type === "node_start").map((e) => e.nodeId).sort();
    const dones = events.filter((e) => e.type === "node_done").map((e) => e.nodeId).sort();
    expect(starts).toEqual(["a", "b"]);
    expect(dones).toEqual(["a", "b"]);
  });

  it("respects dependsOn ordering: dependent node runs after its dependency", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    // b depends on a — b must not start until a is done.
    const ir = new SimpleIR([
      { id: "a", toolName: "double", args: { value: 3 }, dependsOn: [], readOnly: true, idempotent: true },
      { id: "b", toolName: "double", args: { value: 4 }, dependsOn: ["a"], readOnly: true, idempotent: true },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);

    expect(events).toHaveLength(4);
    const seq = events.map((e) => `${e.type}:${e.nodeId}`);
    // a starts → a done → b starts → b done
    expect(seq).toEqual(["node_start:a", "node_done:a", "node_start:b", "node_done:b"]);
  });

  it("produces correct output values", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    const ir = new SimpleIR([
      { id: "x", toolName: "double", args: { value: 7 }, dependsOn: [], readOnly: true, idempotent: true },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);
    const done = events.find((e) => e.type === "node_done");
    expect((done?.result as { output: unknown }).output).toBe(14);
  });

  it("throws on circular dependency (deadlock)", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    // a depends on b, b depends on a — cycle
    const ir = new SimpleIR([
      { id: "a", toolName: "double", args: { value: 1 }, dependsOn: ["b"], readOnly: true, idempotent: true },
      { id: "b", toolName: "double", args: { value: 2 }, dependsOn: ["a"], readOnly: true, idempotent: true },
    ]);

    const gen = scheduler.execute(ir);
    await expect(async () => {
      for await (const _ of gen) { /* consume */ }
    }).rejects.toThrow("deadlock");
  });

  it("SimpleIR.toJSON / fromJSON round-trip", () => {
    const ir = new SimpleIR([
      { id: "x", toolName: "double", args: { value: 3 }, dependsOn: [], readOnly: true, idempotent: true },
    ]);
    const json = ir.toJSON() as { nodes: typeof ir.nodes };
    const restored = SimpleIR.fromJSON(json);
    expect(restored.nodes[0]?.id).toBe("x");
    expect(restored.nodes[0]?.args["value"]).toBe(3);
  });

  it("C3: readOnly node is launched speculatively before non-readOnly barrier clears", async () => {
    // slow-write: non-readOnly, takes "time" (but we can't add real delay without flakiness —
    // instead verify event ordering: readOnly nodes' start appears before the write node's start).
    let callOrder: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "read_op",
      description: "readOnly read",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ v }) => { callOrder.push("read_op"); return v; },
    });
    registry.register({
      name: "write_op",
      description: "non-readOnly write",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.number(),
      readOnly: false,
      idempotent: false,
      forward: async ({ v }) => { callOrder.push("write_op"); return v; },
    });

    const scheduler = new Scheduler(registry);
    // read_op has no deps (readOnly — speculative), write_op has no deps but is !readOnly — barrier.
    const ir = new SimpleIR([
      { id: "r", toolName: "read_op", args: { v: 1 }, dependsOn: [], readOnly: true, idempotent: true },
      { id: "w", toolName: "write_op", args: { v: 2 }, dependsOn: [], readOnly: false, idempotent: false },
    ]);

    const events: string[] = [];
    for await (const e of scheduler.execute(ir)) {
      events.push(`${e.type}:${e.nodeId}`);
    }

    // r must start before w starts (speculative launch).
    const rStart = events.indexOf("node_start:r");
    const wStart = events.indexOf("node_start:w");
    expect(rStart).toBeLessThan(wStart);
    expect(callOrder).toContain("read_op");
    expect(callOrder).toContain("write_op");
  });
});

describe("Scheduler extraCapabilities forwarding (A2)", () => {
  it("returns capability_denied result when IRNode extraCapabilities omits required capability", async () => {
    const gateTool: ToolDefinition<{ v: number }, number> = {
      name: "gated",
      description: "Needs a capability",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      requiredCapability: "tool:special",
      forward: async ({ v }) => v,
    };
    const registry = makeRegistry(gateTool);
    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "g",
        toolName: "gated",
        args: { v: 1 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
        // extraCapabilities omitted — capability_denied expected
      },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);
    const done = events.find((e) => e.type === "node_done");
    const result = done?.result as { error?: { code: string } };
    expect(result.error?.code).toBe("capability_denied");
  });

  it("succeeds when IRNode extraCapabilities includes the required capability", async () => {
    const gateTool: ToolDefinition<{ v: number }, number> = {
      name: "gated2",
      description: "Needs a capability",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      requiredCapability: "tool:special",
      forward: async ({ v }) => v * 3,
    };
    const registry = makeRegistry(gateTool);
    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "g",
        toolName: "gated2",
        args: { v: 4 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
        extraCapabilities: ["tool:special"],
      },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);
    const done = events.find((e) => e.type === "node_done");
    const result = done?.result as { output: unknown };
    expect(result.output).toBe(12);
  });
});

describe("Scheduler edge cases", () => {
  it("empty IR completes immediately with zero events", async () => {
    const registry = makeRegistry(doubleTool);
    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);

    expect(events).toHaveLength(0);
  });
});
