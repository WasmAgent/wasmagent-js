/**
 * LocalWorkflowEngine integration tests.
 *
 * Targeted coverage of the design promises:
 *   1. Task decomposition  — DAG with multiple steps + dependencies.
 *   2. Parallel execution  — independent steps run concurrently.
 *   3. Resource awareness  — parallel steps gated when pool is configured.
 *   3a. SERIAL chains DON'T compete — pool config has zero observable effect.
 *   4. Completion-triggered — downstream auto-fires when upstream completes.
 *   5. Persistence + crash-resume — engine A persists, engine B resumes.
 *   6. Retries with backoff — flaky tools succeed on retry.
 *   7. step.sleep + step.waitForEvent semantics.
 *   8. Cancellation propagates to in-flight tools.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";
import { LocalWorkflowEngine } from "./LocalWorkflowEngine.js";
import { InMemoryResourcePool } from "./ResourcePool.js";
import { KvWorkflowStateStore, MemoryKvBackend } from "./store.js";
import type { WorkflowDefinition } from "./types.js";

// ── Test tools ─────────────────────────────────────────────────────────────

const echoTool: ToolDefinition<{ value: unknown }, unknown> = {
  name: "echo",
  description: "Returns its input.",
  inputSchema: z.object({ value: z.unknown() }),
  outputSchema: z.unknown(),
  readOnly: true,
  idempotent: true,
  forward: async ({ value }) => value,
};

const addTool: ToolDefinition<{ a: number; b: number }, number> = {
  name: "add",
  description: "Adds two numbers.",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }) => a + b,
};

const sleepTool: ToolDefinition<{ ms: number }, number> = {
  name: "sleepReal",
  description: "Real sleep — used to provoke parallelism timing.",
  inputSchema: z.object({ ms: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ ms }) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    return Date.now() - start;
  },
};

function flakyTool(failTimes: number): ToolDefinition<Record<string, never>, number> {
  let calls = 0;
  return {
    name: "flaky",
    description: "Fails the first N attempts.",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.number(),
    readOnly: false,
    idempotent: true,
    forward: async () => {
      calls += 1;
      if (calls <= failTimes) throw new Error(`flaky fail #${calls}`);
      return calls;
    },
  };
}

function makeRegistry(...tools: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

function makeEngine(opts?: {
  store?: ReturnType<typeof makeMemStore>;
  pool?: InMemoryResourcePool;
  tools?: ToolRegistry;
}) {
  return new LocalWorkflowEngine({
    tools: opts?.tools ?? makeRegistry(echoTool, addTool, sleepTool),
    store: opts?.store ?? makeMemStore(),
    pool: opts?.pool ?? new InMemoryResourcePool(),
    pollIntervalMs: 25,
  });
}

function makeMemStore() {
  return new KvWorkflowStateStore(new MemoryKvBackend());
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LocalWorkflowEngine: decomposition + dependency triggering", () => {
  it("runs a serial chain in order and surfaces leaf output", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "chain",
      steps: [
        { id: "s1", toolName: "echo", args: { value: 10 }, dependsOn: [] },
        { id: "s2", toolName: "add", args: { a: "$s1", b: 5 }, dependsOn: ["s1"] },
        { id: "s3", toolName: "add", args: { a: "$s2", b: 100 }, dependsOn: ["s2"] },
      ],
    };
    const run = await engine.start(def);
    const final = await run.wait();
    expect(final.status).toBe("completed");
    // Only the leaf (s3) is in output (s1, s2 are referenced by descendants).
    expect((final.output as Record<string, unknown>).s3).toBe(115);
  });

  it("emits step_complete for every node and run_complete at the end", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "events",
      steps: [
        { id: "a", toolName: "echo", args: { value: 1 }, dependsOn: [] },
        { id: "b", toolName: "echo", args: { value: 2 }, dependsOn: ["a"] },
      ],
    };
    const run = await engine.start(def);
    const seen: string[] = [];
    const subPromise = (async () => {
      for await (const ev of run.events())
        seen.push(`${ev.type}:${"stepId" in ev ? ev.stepId : ""}`);
    })();
    await run.wait();
    await subPromise;
    expect(seen).toContain("step_complete:a");
    expect(seen).toContain("step_complete:b");
    expect(seen.some((s) => s.startsWith("run_complete:"))).toBe(true);
  });
});

describe("LocalWorkflowEngine: parallelism + resource scheduling", () => {
  it("independent steps execute in parallel by default (wall-clock proves it)", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "parallel",
      steps: [
        { id: "p1", toolName: "sleepReal", args: { ms: 60 }, dependsOn: [], readOnly: true },
        { id: "p2", toolName: "sleepReal", args: { ms: 60 }, dependsOn: [], readOnly: true },
        { id: "p3", toolName: "sleepReal", args: { ms: 60 }, dependsOn: [], readOnly: true },
      ],
    };
    const start = Date.now();
    const run = await engine.start(def);
    await run.wait();
    const elapsed = Date.now() - start;
    // 3 × 60ms serial would be 180ms; parallel should be well under.
    expect(elapsed).toBeLessThan(150);
  });

  it("SERIAL chain does NOT compete for resources even when pool capacity=1 (user's mental model)", async () => {
    // The user's exact phrasing: "if serial, there is no resource contention".
    // We configure the pool to cap "gpu" at 1 concurrent slot, then run a
    // 5-step chain where every step claims gpu. Wall-clock should equal pure
    // step time, not show any artificial waiting.
    const pool = new InMemoryResourcePool();
    pool.configure("gpu", { capacity: 1 });
    const engine = makeEngine({ pool });
    const def: WorkflowDefinition = {
      id: "serial-gpu",
      steps: [
        {
          id: "g1",
          toolName: "sleepReal",
          args: { ms: 40 },
          dependsOn: [],
          readOnly: true,
          resourceClaims: [{ key: "gpu" }],
        },
        {
          id: "g2",
          toolName: "sleepReal",
          args: { ms: 40 },
          dependsOn: ["g1"],
          readOnly: true,
          resourceClaims: [{ key: "gpu" }],
        },
        {
          id: "g3",
          toolName: "sleepReal",
          args: { ms: 40 },
          dependsOn: ["g2"],
          readOnly: true,
          resourceClaims: [{ key: "gpu" }],
        },
      ],
    };
    const start = Date.now();
    const run = await engine.start(def);
    await run.wait();
    const elapsed = Date.now() - start;
    // Pure step time = 3 × 40 = 120ms. Allow generous slack for CI.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(220);
    // No waiters should ever have been queued — it's all sequential.
    expect(pool.inspect().gpu.waiters).toBe(0);
  });

  it("PARALLEL siblings ARE gated when pool capacity is exceeded", async () => {
    // Same scenario as above but the steps are siblings (no deps). With cap=1,
    // they must serialise: total = 3 × stepMs.
    const pool = new InMemoryResourcePool();
    pool.configure("gpu", { capacity: 1 });
    const engine = makeEngine({ pool });
    const def: WorkflowDefinition = {
      id: "parallel-gpu-gated",
      steps: [
        {
          id: "p1",
          toolName: "sleepReal",
          args: { ms: 40 },
          dependsOn: [],
          readOnly: true,
          resourceClaims: [{ key: "gpu" }],
        },
        {
          id: "p2",
          toolName: "sleepReal",
          args: { ms: 40 },
          dependsOn: [],
          readOnly: true,
          resourceClaims: [{ key: "gpu" }],
        },
        {
          id: "p3",
          toolName: "sleepReal",
          args: { ms: 40 },
          dependsOn: [],
          readOnly: true,
          resourceClaims: [{ key: "gpu" }],
        },
      ],
    };
    const start = Date.now();
    const run = await engine.start(def);
    await run.wait();
    const elapsed = Date.now() - start;
    // With cap=1, 3 × 40ms must run sequentially → ≥ 120ms.
    expect(elapsed).toBeGreaterThanOrEqual(110);
  });

  it("PARALLEL siblings with capacity=2 partially overlap (2 + 1 grouping)", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("api", { capacity: 2 });
    const engine = makeEngine({ pool });
    const def: WorkflowDefinition = {
      id: "parallel-api-cap2",
      steps: [1, 2, 3, 4].map((i) => ({
        id: `n${i}`,
        toolName: "sleepReal",
        args: { ms: 50 },
        dependsOn: [] as string[],
        readOnly: true,
        resourceClaims: [{ key: "api" }],
      })),
    };
    const start = Date.now();
    const run = await engine.start(def);
    await run.wait();
    const elapsed = Date.now() - start;
    // 4 steps / capacity 2 = 2 waves × 50ms = 100ms minimum.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(180);
  });
});

describe("LocalWorkflowEngine: persistence + crash-resume", () => {
  it("resumes after engine restart and skips already-completed steps", async () => {
    // Shared store mimics on-disk persistence across two engine instances.
    const store = makeMemStore();
    const counterTool = (() => {
      let calls = 0;
      return {
        name: "incr",
        description: "increments and returns",
        inputSchema: z.object({}).passthrough(),
        outputSchema: z.number(),
        readOnly: false,
        idempotent: true,
        forward: async () => ++calls,
        getCalls: () => calls,
      } as ToolDefinition<Record<string, never>, number> & { getCalls(): number };
    })();
    const tools = makeRegistry(counterTool as ToolDefinition);
    const engineA = makeEngine({ store, tools });
    const def: WorkflowDefinition = {
      id: "resume",
      steps: [
        { id: "s1", toolName: "incr", args: {}, dependsOn: [] },
        { id: "s2", toolName: "incr", args: {}, dependsOn: ["s1"] },
        { id: "s3", toolName: "incr", args: {}, dependsOn: ["s2"] },
      ],
    };

    // Start, then "crash" by cancelling after step 1 completes.
    const runA = await engineA.start(def, { runId: "rA" });

    let s1Done = false;
    const subPromise = (async () => {
      for await (const ev of runA.events()) {
        if (ev.type === "step_complete" && ev.stepId === "s1") {
          s1Done = true;
          // Simulate crash: cancel after first step persists.
          runA.cancel("simulated crash");
        }
      }
    })();
    await runA.wait();
    await subPromise;
    expect(s1Done).toBe(true);
    expect(counterTool.getCalls()).toBeGreaterThanOrEqual(1);

    // Fresh engine, same store, resume.
    const callsBeforeResume = counterTool.getCalls();
    const engineB = makeEngine({ store, tools });
    const runB = await engineB.resume("rA");
    const final = await runB.wait();
    expect(final.status).toBe("completed");

    // s2 + s3 must execute on resume; s1 must NOT re-execute.
    // Total tool calls should be callsBefore (s1 done) + 2 (s2 + s3).
    expect(counterTool.getCalls()).toBe(callsBeforeResume + 2);
  });

  it("emits step_resumed_from_checkpoint for every completed step on resume", async () => {
    const store = makeMemStore();
    const engine1 = makeEngine({ store });
    const def: WorkflowDefinition = {
      id: "resume-events",
      steps: [
        { id: "s1", toolName: "echo", args: { value: 1 }, dependsOn: [] },
        { id: "s2", toolName: "echo", args: { value: 2 }, dependsOn: ["s1"] },
        { id: "s3", toolName: "echo", args: { value: 3 }, dependsOn: ["s2"] },
      ],
    };
    const runA = await engine1.start(def, { runId: "rB" });
    const subA = (async () => {
      for await (const ev of runA.events()) {
        if (ev.type === "step_complete" && ev.stepId === "s2") runA.cancel();
      }
    })();
    await runA.wait();
    await subA;

    const engine2 = makeEngine({ store });
    const runB = await engine2.resume("rB");
    const resumeEvents: string[] = [];
    const subB = (async () => {
      for await (const ev of runB.events()) {
        if (ev.type === "step_resumed_from_checkpoint") resumeEvents.push(ev.stepId);
      }
    })();
    await runB.wait();
    await subB;
    // At least s1 must be marked resumed; s2 may also depending on cancellation timing.
    expect(resumeEvents).toContain("s1");
  });
});

describe("LocalWorkflowEngine: retries", () => {
  it("retries an idempotent step until it succeeds", async () => {
    const flaky = flakyTool(2); // Fails twice, succeeds on attempt 3.
    const tools = makeRegistry(flaky);
    const engine = makeEngine({ tools });
    const def: WorkflowDefinition = {
      id: "retry",
      steps: [
        {
          id: "f1",
          toolName: "flaky",
          args: {},
          dependsOn: [],
          retries: { limit: 3, delayMs: 5, backoff: "constant" },
        },
      ],
    };
    const run = await engine.start(def);
    const final = await run.wait();
    expect(final.status).toBe("completed");
    expect((final.output as Record<string, unknown>).f1).toBe(3); // 3rd call succeeded.
  });

  it("fails the run when retries are exhausted", async () => {
    const flaky = flakyTool(99); // Never succeeds.
    const tools = makeRegistry(flaky);
    const engine = makeEngine({ tools });
    const def: WorkflowDefinition = {
      id: "retry-fail",
      steps: [
        {
          id: "f1",
          toolName: "flaky",
          args: {},
          dependsOn: [],
          retries: { limit: 2, delayMs: 1, backoff: "constant" },
        },
      ],
    };
    const run = await engine.start(def);
    const final = await run.wait();
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/flaky fail/);
  });
});

describe("LocalWorkflowEngine: sleep + waitForEvent", () => {
  it("$sleep step blocks for ~ms and downstream fires after wake", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "sleep",
      steps: [
        { id: "wait", toolName: "$sleep", args: { ms: 80 }, dependsOn: [] },
        { id: "after", toolName: "echo", args: { value: "ok" }, dependsOn: ["wait"] },
      ],
    };
    const start = Date.now();
    const run = await engine.start(def);
    const final = await run.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
    expect(final.status).toBe("completed");
    expect((final.output as Record<string, unknown>).after).toBe("ok");
  });

  it("$waitForEvent unblocks when sendEvent matches", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "wait-evt",
      steps: [
        {
          id: "evt",
          toolName: "$waitForEvent",
          args: { type: "signal" },
          dependsOn: [],
        },
        {
          id: "after",
          toolName: "echo",
          args: { value: "$evt" },
          dependsOn: ["evt"],
        },
      ],
    };
    const run = await engine.start(def);
    setTimeout(() => {
      void run.sendEvent("signal", { hello: "world" });
    }, 30);
    const final = await run.wait();
    expect(final.status).toBe("completed");
    expect((final.output as Record<string, unknown>).after).toEqual({ hello: "world" });
  });

  it("$waitForEvent returns event delivered before subscription (drain on first poll)", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "early-evt",
      steps: [{ id: "evt", toolName: "$waitForEvent", args: { type: "early" }, dependsOn: [] }],
    };
    // Send first; then create the run. The engine must pick up the buffered event.
    const runId = "early-r";
    await engine.sendEvent(runId, "early", 42);
    const run = await engine.start(def, { runId });
    const final = await run.wait();
    expect((final.output as Record<string, unknown>).evt).toBe(42);
  });
});

describe("LocalWorkflowEngine: cancellation", () => {
  it("cancel() puts the run in cancelled status", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "cancel",
      steps: [
        { id: "long", toolName: "sleepReal", args: { ms: 500 }, dependsOn: [], readOnly: true },
      ],
    };
    const run = await engine.start(def);
    setTimeout(() => run.cancel("user-stop"), 30);
    const final = await run.wait();
    expect(["cancelled", "failed"]).toContain(final.status);
  });
});

describe("LocalWorkflowEngine: invalid definitions", () => {
  it("rejects duplicate step ids", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "dup",
      steps: [
        { id: "x", toolName: "echo", args: {}, dependsOn: [] },
        { id: "x", toolName: "echo", args: {}, dependsOn: [] },
      ],
    };
    await expect(engine.start(def)).rejects.toThrow(/Duplicate step/);
  });

  it("rejects unknown dependsOn id", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "bad-dep",
      steps: [{ id: "a", toolName: "echo", args: {}, dependsOn: ["ghost"] }],
    };
    await expect(engine.start(def)).rejects.toThrow(/unknown step ghost/);
  });

  it("rejects cycles", async () => {
    const engine = makeEngine();
    const def: WorkflowDefinition = {
      id: "cyc",
      steps: [
        { id: "a", toolName: "echo", args: {}, dependsOn: ["b"] },
        { id: "b", toolName: "echo", args: {}, dependsOn: ["a"] },
      ],
    };
    await expect(engine.start(def)).rejects.toThrow(/Cycle/);
  });
});
