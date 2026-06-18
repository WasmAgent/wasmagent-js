/**
 * CloudflareWorkflowEngine integration tests using a fake CF binding so we
 * can exercise the engine surface without a live Cloudflare account.
 *
 * The fake binding stores instance state in-memory and emulates step.do /
 * step.sleep / step.waitForEvent against the runWorkflowEntrypoint helper.
 */

import type { WorkflowDefinition, WorkflowStateStore } from "@wasmagent/core";
import { KvWorkflowStateStore, MemoryKvBackend } from "@wasmagent/core";
import { describe, expect, it } from "vitest";
import {
  type CfStepConfig,
  type CfWorkflowBinding,
  type CfWorkflowInstance,
  type CfWorkflowStep,
  CloudflareWorkflowEngine,
  runWorkflowEntrypoint,
} from "./CloudflareWorkflowEngine.js";

// ── Fake binding ──────────────────────────────────────────────────────────

interface FakeInstanceState {
  id: string;
  status: string;
  output?: unknown;
  error?: string;
  pendingEvents: { type: string; payload: unknown }[];
  resolvers: Map<string, (env: { payload: unknown }) => void>;
}

class FakeBinding implements CfWorkflowBinding {
  readonly instances = new Map<string, FakeInstanceState>();
  /** Caller plugs in the workflow run logic — what runs when create() is called. */
  constructor(
    private readonly entry: (
      event: { instanceId: string; payload: unknown; timestamp: Date },
      step: CfWorkflowStep
    ) => Promise<unknown>
  ) {}

  async create(opts?: { id?: string; params?: unknown }): Promise<CfWorkflowInstance> {
    const id = opts?.id ?? `wf-${Math.random().toString(36).slice(2)}`;
    const state: FakeInstanceState = {
      id,
      status: "queued",
      pendingEvents: [],
      resolvers: new Map(),
    };
    this.instances.set(id, state);

    const step = this.#makeStep(state);
    state.status = "running";
    void this.entry({ instanceId: id, payload: opts?.params, timestamp: new Date(0) }, step)
      .then((output) => {
        state.status = "complete";
        state.output = output;
      })
      .catch((err) => {
        state.status = "errored";
        state.error = err instanceof Error ? err.message : String(err);
      });

    return this.#wrap(state);
  }

  async get(id: string): Promise<CfWorkflowInstance> {
    const state = this.instances.get(id);
    if (!state) throw new Error(`unknown instance: ${id}`);
    return this.#wrap(state);
  }

  #wrap(state: FakeInstanceState): CfWorkflowInstance {
    return {
      id: state.id,
      status: async () => ({
        status: state.status,
        ...(state.output !== undefined ? { output: state.output } : {}),
        ...(state.error !== undefined ? { error: state.error } : {}),
      }),
      terminate: async () => {
        state.status = "terminated";
      },
      pause: async () => {
        state.status = "paused";
      },
      resume: async () => {
        state.status = "running";
      },
      restart: async () => {
        state.status = "running";
      },
      sendEvent: async (event) => {
        const r = state.resolvers.get(event.type);
        if (r) {
          state.resolvers.delete(event.type);
          r({ payload: event.payload });
        } else {
          state.pendingEvents.push(event);
        }
      },
    };
  }

  #makeStep(state: FakeInstanceState): CfWorkflowStep {
    // Implementation overload signatures: (name, cb) | (name, cfg, cb).
    const stepDo = async <T>(
      _name: string,
      a: CfStepConfig | (() => Promise<T>),
      b?: () => Promise<T>
    ): Promise<T> => {
      const cb = typeof a === "function" ? a : b!;
      // Honour basic retry config — re-run the callback up to limit times.
      const cfg = typeof a === "object" ? a : undefined;
      const limit = cfg?.retries?.limit ?? 1;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= limit; attempt++) {
        try {
          return await cb();
        } catch (err) {
          lastErr = err;
          if (attempt === limit) throw err;
        }
      }
      throw lastErr;
    };
    return {
      do: stepDo as CfWorkflowStep["do"],
      sleep: async (_name: string, duration: string | number) => {
        const ms = typeof duration === "number" ? duration : parseDuration(duration);
        await new Promise((r) => setTimeout(r, ms));
      },
      sleepUntil: async (_name: string, ts: Date | number) => {
        const target = typeof ts === "number" ? ts : ts.getTime();
        const diff = target - Date.now();
        if (diff > 0) await new Promise((r) => setTimeout(r, diff));
      },
      waitForEvent: <T = unknown>(
        _name: string,
        opts: { type: string; timeout?: string | number }
      ) => {
        // Match a queued event, otherwise wait on a resolver.
        const idx = state.pendingEvents.findIndex((e) => e.type === opts.type);
        if (idx !== -1) {
          const [hit] = state.pendingEvents.splice(idx, 1);
          return Promise.resolve({ payload: hit!.payload as T });
        }
        return new Promise((resolve) => {
          state.resolvers.set(opts.type, resolve as (e: { payload: unknown }) => void);
        });
      },
    };
  }
}

function parseDuration(s: string): number {
  const m = /^(\d+)\s*(ms|s|seconds?|minutes?|m)$/i.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]?.toLowerCase()) {
    case "ms":
      return n;
    case "s":
    case "second":
    case "seconds":
      return n * 1000;
    case "m":
    case "minute":
    case "minutes":
      return n * 60_000;
    default:
      return n;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

const echoDef: WorkflowDefinition = {
  id: "cf-demo",
  steps: [
    { id: "a", toolName: "echo", args: { value: 1 }, dependsOn: [] },
    { id: "b", toolName: "echo", args: { value: "$a" }, dependsOn: ["a"] },
  ],
};

describe("CloudflareWorkflowEngine — adapter parity", () => {
  it("runs a serial chain via the entrypoint helper", async () => {
    const store: WorkflowStateStore = new KvWorkflowStateStore(new MemoryKvBackend());
    const binding = new FakeBinding(async (event, step) =>
      runWorkflowEntrypoint(event, step, echoDef, {
        resolveTool: async ({ args }) => args.value,
        store,
      })
    );
    const engine = new CloudflareWorkflowEngine({ binding, store });
    const run = await engine.start(echoDef, { runId: "run-1" });
    const final = await run.wait();
    expect(final.status).toBe("completed");
    // Output collects only leaf steps (b), and `b` echoes `$a` → 1.
    expect((final.output as Record<string, unknown>).b).toBe(1);
  });

  it("records step completions in the shared WorkflowStateStore", async () => {
    const store: WorkflowStateStore = new KvWorkflowStateStore(new MemoryKvBackend());
    const binding = new FakeBinding(async (event, step) =>
      runWorkflowEntrypoint(event, step, echoDef, {
        resolveTool: async ({ args }) => args.value,
        store,
      })
    );
    const engine = new CloudflareWorkflowEngine({ binding, store });
    const run = await engine.start(echoDef, { runId: "run-2" });
    await run.wait();
    const records = await store.listSteps("run-2");
    expect(records.map((r) => r.stepId).sort()).toEqual(["a", "b"]);
    expect(records.every((r) => r.status === "completed")).toBe(true);
  });

  it("$sleep and $waitForEvent translate to step.sleep / step.waitForEvent", async () => {
    const store: WorkflowStateStore = new KvWorkflowStateStore(new MemoryKvBackend());
    const def: WorkflowDefinition = {
      id: "cf-sleep-evt",
      steps: [
        { id: "wait", toolName: "$sleep", args: { ms: 30 }, dependsOn: [] },
        {
          id: "evt",
          toolName: "$waitForEvent",
          args: { type: "pulse" },
          dependsOn: ["wait"],
        },
      ],
    };
    const binding = new FakeBinding(async (event, step) =>
      runWorkflowEntrypoint(event, step, def, {
        resolveTool: async () => null,
        store,
      })
    );
    const engine = new CloudflareWorkflowEngine({ binding, store });
    const run = await engine.start(def, { runId: "run-3" });
    setTimeout(() => {
      void run.sendEvent("pulse", { hi: 1 });
    }, 70);
    const final = await run.wait();
    expect(final.status).toBe("completed");
    expect((final.output as Record<string, unknown>).evt).toEqual({ hi: 1 });
  });

  it("retry config is honoured on the fake step.do", async () => {
    const store: WorkflowStateStore = new KvWorkflowStateStore(new MemoryKvBackend());
    let calls = 0;
    const def: WorkflowDefinition = {
      id: "cf-retry",
      steps: [
        {
          id: "f",
          toolName: "flaky",
          args: {},
          dependsOn: [],
          retries: { limit: 3, delayMs: 1 },
        },
      ],
    };
    const binding = new FakeBinding(async (event, step) =>
      runWorkflowEntrypoint(event, step, def, {
        resolveTool: async () => {
          calls += 1;
          if (calls < 3) throw new Error("flaky");
          return calls;
        },
        store,
      })
    );
    const engine = new CloudflareWorkflowEngine({ binding, store });
    const run = await engine.start(def, { runId: "run-4" });
    const final = await run.wait();
    expect(final.status).toBe("completed");
    expect((final.output as Record<string, unknown>).f).toBe(3);
  });

  it("rejects definitions that exceed CF step ceiling", async () => {
    const store: WorkflowStateStore = new KvWorkflowStateStore(new MemoryKvBackend());
    const binding = new FakeBinding(async () => undefined);
    const engine = new CloudflareWorkflowEngine({ binding, store });
    const def: WorkflowDefinition = {
      id: "huge",
      steps: Array.from({ length: 24_001 }, (_, i) => ({
        id: `n${i}`,
        toolName: "echo",
        args: {},
        dependsOn: [] as string[],
      })),
    };
    await expect(engine.start(def)).rejects.toThrow(/exceeds the Cloudflare/);
  });

  it("cycle in definition is detected by topoSort", async () => {
    const store: WorkflowStateStore = new KvWorkflowStateStore(new MemoryKvBackend());
    const def: WorkflowDefinition = {
      id: "cyc",
      steps: [
        { id: "a", toolName: "echo", args: {}, dependsOn: ["b"] },
        { id: "b", toolName: "echo", args: {}, dependsOn: ["a"] },
      ],
    };
    const binding = new FakeBinding(async (event, step) =>
      runWorkflowEntrypoint(event, step, def, {
        resolveTool: async () => null,
        store,
      })
    );
    const engine = new CloudflareWorkflowEngine({ binding, store });
    const run = await engine.start(def, { runId: "run-5" });
    const final = await run.wait();
    expect(final.status).toBe("failed");
    expect(final.error ?? "").toMatch(/Cycle/);
  });
});
