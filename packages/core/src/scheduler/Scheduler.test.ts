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
      {
        id: "n1",
        toolName: "double",
        args: { value: 5 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);
    // readOnly nodes emit node_start + node_speculative + node_done (B1).
    const types = events.map((e) => e.type);
    expect(types).toContain("node_start");
    expect(types).toContain("node_done");
    const doneEvent = events.find((e) => e.type === "node_done");
    const result = (doneEvent?.type === "node_done" ? doneEvent.result : undefined) as {
      output: unknown;
    };
    expect(result.output).toBe(10);
  });

  it("independent nodes run in parallel (both node_start before any node_done)", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    const ir = new SimpleIR([
      {
        id: "a",
        toolName: "double",
        args: { value: 1 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
      {
        id: "b",
        toolName: "double",
        args: { value: 2 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);

    // Both starts are emitted before any done (wave-parallel semantics).
    // Filter to node_start/node_done to ignore the new node_speculative events (B1).
    const types = events
      .filter((e) => e.type === "node_start" || e.type === "node_done")
      .map((e) => e.type);
    expect(types).toEqual(["node_start", "node_start", "node_done", "node_done"]);

    // Both node IDs appear in starts and dones.
    const starts = events
      .filter((e) => e.type === "node_start")
      .map((e) => e.nodeId)
      .sort();
    const dones = events
      .filter((e) => e.type === "node_done")
      .map((e) => e.nodeId)
      .sort();
    expect(starts).toEqual(["a", "b"]);
    expect(dones).toEqual(["a", "b"]);
  });

  it("respects dependsOn ordering: dependent node runs after its dependency", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    // b depends on a — b must not start until a is done.
    const ir = new SimpleIR([
      {
        id: "a",
        toolName: "double",
        args: { value: 3 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
      {
        id: "b",
        toolName: "double",
        args: { value: 4 },
        dependsOn: ["a"],
        readOnly: true,
        idempotent: true,
      },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);

    // Filter to core events only; ignore node_speculative (B1 observability).
    const seq = events
      .filter((e) => e.type === "node_start" || e.type === "node_done")
      .map((e) => `${e.type}:${e.nodeId}`);
    // a starts → a done → b starts → b done
    expect(seq).toEqual(["node_start:a", "node_done:a", "node_start:b", "node_done:b"]);
  });

  it("produces correct output values", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    const ir = new SimpleIR([
      {
        id: "x",
        toolName: "double",
        args: { value: 7 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
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
      {
        id: "a",
        toolName: "double",
        args: { value: 1 },
        dependsOn: ["b"],
        readOnly: true,
        idempotent: true,
      },
      {
        id: "b",
        toolName: "double",
        args: { value: 2 },
        dependsOn: ["a"],
        readOnly: true,
        idempotent: true,
      },
    ]);

    const gen = scheduler.execute(ir);
    await expect(
      (async () => {
        for await (const _ of gen) {
          /* consume */
        }
      })()
    ).rejects.toThrow("deadlock");
  });

  it("SimpleIR.toJSON / fromJSON round-trip", () => {
    const ir = new SimpleIR([
      {
        id: "x",
        toolName: "double",
        args: { value: 3 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
    ]);
    const json = ir.toJSON() as { nodes: typeof ir.nodes };
    const restored = SimpleIR.fromJSON(json);
    expect(restored.nodes[0]?.id).toBe("x");
    expect(restored.nodes[0]?.args.value).toBe(3);
  });

  it("C3: readOnly node is launched speculatively before non-readOnly barrier clears", async () => {
    // slow-write: non-readOnly, takes "time" (but we can't add real delay without flakiness —
    // instead verify event ordering: readOnly nodes' start appears before the write node's start).
    const callOrder: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "read_op",
      description: "readOnly read",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ v }) => {
        callOrder.push("read_op");
        return v;
      },
    });
    registry.register({
      name: "write_op",
      description: "non-readOnly write",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.number(),
      readOnly: false,
      idempotent: false,
      forward: async ({ v }) => {
        callOrder.push("write_op");
        return v;
      },
    });

    const scheduler = new Scheduler(registry);
    // read_op has no deps (readOnly — speculative), write_op has no deps but is !readOnly — barrier.
    const ir = new SimpleIR([
      {
        id: "r",
        toolName: "read_op",
        args: { v: 1 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
      {
        id: "w",
        toolName: "write_op",
        args: { v: 2 },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
      },
    ]);

    const events: string[] = [];
    for await (const e of scheduler.execute(ir)) {
      const nodeId = "nodeId" in e ? e.nodeId : "_barrier_";
      events.push(`${e.type}:${nodeId}`);
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

// ── C1: $ref value substitution ───────────────────────────────────────────────

describe("Scheduler — C1 $ref value substitution", () => {
  it("substitutes $callId with upstream result in downstream args", async () => {
    let capturedInput: Record<string, unknown> | undefined;

    const registry = new ToolRegistry();
    // call-A produces { output: 42 }
    registry.register({
      name: "produce",
      description: "produces a value",
      inputSchema: z.object({ seed: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ seed }) => seed * 10,
    });
    // call-B captures whatever it receives as input
    registry.register({
      name: "consume",
      description: "consumes upstream output",
      inputSchema: z.object({ src: z.unknown() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async (input) => {
        capturedInput = input as Record<string, unknown>;
        return "ok";
      },
    });

    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "call-A",
        toolName: "produce",
        args: { seed: 4 },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
      {
        id: "call-B",
        toolName: "consume",
        args: { src: "$call-A" },
        dependsOn: ["call-A"],
        readOnly: true,
        idempotent: true,
      },
    ]);

    const events = [];
    for await (const e of scheduler.execute(ir)) events.push(e);

    // call-B should receive the actual result of call-A, not the literal "$call-A"
    expect(capturedInput?.src).not.toBe("$call-A");
    // call-A output is { callId, toolName, output: 40 }
    const callAResult = (
      events.find((e) => e.type === "node_done" && e.nodeId === "call-A") as
        | { type: "node_done"; nodeId: string; result: unknown }
        | undefined
    )?.result;
    expect(capturedInput?.src).toEqual(callAResult);
  });

  it("does not substitute when no $ref is present (pure-ordering case)", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const registry = new ToolRegistry();
    registry.register({
      name: "passthrough",
      description: "pass",
      inputSchema: z.object({ val: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async (input) => {
        capturedArgs = input as Record<string, unknown>;
        return "ok";
      },
    });

    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "n1",
        toolName: "passthrough",
        args: { val: "literal" },
        dependsOn: [],
        readOnly: true,
        idempotent: true,
      },
    ]);

    for await (const _ of scheduler.execute(ir)) {
      /* consume */
    }

    // No substitution should have happened
    expect(capturedArgs?.val).toBe("literal");
  });

  it("C1: circular dependencies still throw (not affected by ref substitution)", async () => {
    const scheduler = new Scheduler(makeRegistry(doubleTool));
    const ir = new SimpleIR([
      {
        id: "a",
        toolName: "double",
        args: { value: "$b" },
        dependsOn: ["b"],
        readOnly: true,
        idempotent: true,
      },
      {
        id: "b",
        toolName: "double",
        args: { value: "$a" },
        dependsOn: ["a"],
        readOnly: true,
        idempotent: true,
      },
    ]);
    const gen = scheduler.execute(ir);
    await expect(
      (async () => {
        for await (const _ of gen) {
          /* consume */
        }
      })()
    ).rejects.toThrow("deadlock");
  });
});

// ── A4: resourceKey serialization tests ──────────────────────────────────────

describe("Scheduler — A4: resourceKey serialization", () => {
  it("two !readOnly nodes with same resourceKey execute serially (event order)", async () => {
    const executionOrder: string[] = [];
    let _n1Started = false;

    const slowWriteTool: ToolDefinition<{ id: string }, string> = {
      name: "slowWrite",
      description: "slow write tool",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      async forward({ id }) {
        executionOrder.push(`start:${id}`);
        if (id === "a") {
          _n1Started = true;
          await new Promise((r) => setTimeout(r, 10));
        }
        executionOrder.push(`end:${id}`);
        return `done:${id}`;
      },
    };

    const registry = makeRegistry(slowWriteTool);
    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "n1",
        toolName: "slowWrite",
        args: { id: "a" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
        resourceKey: "shared-resource",
      },
      {
        id: "n2",
        toolName: "slowWrite",
        args: { id: "b" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
        resourceKey: "shared-resource",
      },
    ]);

    for await (const _ of scheduler.execute(ir)) {
      /* consume */
    }

    // n1 must fully complete before n2 starts
    expect(executionOrder.indexOf("end:a")).toBeLessThan(executionOrder.indexOf("start:b"));
  });

  it("!readOnly nodes with different resourceKeys still run in parallel", async () => {
    const concurrentCount = { max: 0, current: 0 };
    const parallelWriteTool: ToolDefinition<{ id: string }, string> = {
      name: "parallelWrite",
      description: "tool",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      async forward({ id }) {
        concurrentCount.current++;
        if (concurrentCount.current > concurrentCount.max) {
          concurrentCount.max = concurrentCount.current;
        }
        await new Promise((r) => setTimeout(r, 10));
        concurrentCount.current--;
        return id;
      },
    };

    const registry = makeRegistry(parallelWriteTool);
    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "n1",
        toolName: "parallelWrite",
        args: { id: "a" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
        resourceKey: "resource-A",
      },
      {
        id: "n2",
        toolName: "parallelWrite",
        args: { id: "b" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
        resourceKey: "resource-B",
      },
    ]);

    for await (const _ of scheduler.execute(ir)) {
      /* consume */
    }

    // Different resourceKeys → parallel execution → max concurrent should be > 1
    expect(concurrentCount.max).toBeGreaterThan(1);
  });

  it("nodes without resourceKey are unaffected by nodes that have it", async () => {
    const callOrder: string[] = [];
    const writeTool: ToolDefinition<{ id: string }, string> = {
      name: "write",
      description: "tool",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      async forward({ id }) {
        callOrder.push(id);
        return id;
      },
    };

    const registry = makeRegistry(writeTool);
    const scheduler = new Scheduler(registry);
    const ir = new SimpleIR([
      {
        id: "n1",
        toolName: "write",
        args: { id: "a" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
        resourceKey: "shared",
      },
      {
        id: "n2",
        toolName: "write",
        args: { id: "b" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
      }, // no resourceKey
      {
        id: "n3",
        toolName: "write",
        args: { id: "c" },
        dependsOn: [],
        readOnly: false,
        idempotent: false,
        resourceKey: "shared",
      },
    ]);

    for await (const _ of scheduler.execute(ir)) {
      /* consume */
    }

    // n1 and n3 must be serial (via implicit resourceKey dep); n2 is independent
    expect(callOrder).toContain("a");
    expect(callOrder).toContain("b");
    expect(callOrder).toContain("c");
    // n1 must precede n3 in execution
    expect(callOrder.indexOf("a")).toBeLessThan(callOrder.indexOf("c"));
  });
});
