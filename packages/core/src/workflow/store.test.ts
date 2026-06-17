/**
 * WorkflowStateStore integration tests — covers persistence layer for memory
 * + filesystem backends. Verifies that the same store contract works
 * portably across runtimes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KvWorkflowStateStore,
  MemoryKvBackend,
  type WorkflowStateStore,
} from "./store.js";
import type { KvBackend } from "../checkpoint/index.js";
import type {
  WorkflowDefinition,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from "./types.js";

/**
 * Minimal filesystem KvBackend so we can prove portability across in-memory
 * and on-disk backends without pulling in the full FsKvStore from another package.
 * Exercises the exact set of methods the workflow store uses.
 */
class FsTestKvBackend implements KvBackend {
  constructor(private readonly dir: string) {}
  #fileFor(key: string) {
    // Slashes / colons get encoded so each key maps to one flat file.
    return join(this.dir, encodeURIComponent(key));
  }
  async get(key: string) {
    const fs = await import("node:fs/promises");
    try {
      return await fs.readFile(this.#fileFor(key), "utf8");
    } catch {
      return null;
    }
  }
  async put(key: string, value: string) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(this.#fileFor(key), value, "utf8");
  }
  async delete(key: string) {
    const fs = await import("node:fs/promises");
    try {
      await fs.unlink(this.#fileFor(key));
    } catch {
      /* missing → no-op */
    }
  }
  async list(prefix: string) {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(this.dir).catch(() => []);
    return entries.map((e) => decodeURIComponent(e)).filter((k) => k.startsWith(prefix));
  }
}

const sampleDef: WorkflowDefinition = {
  id: "demo",
  steps: [
    { id: "a", toolName: "noop", args: {}, dependsOn: [] },
    { id: "b", toolName: "noop", args: {}, dependsOn: ["a"] },
  ],
};

const sampleRun: WorkflowRunRecord = {
  runId: "run-1",
  workflowId: "demo",
  status: "running",
  params: { x: 1 },
  createdAt: Date.now(),
};

function suite(label: string, factory: () => { store: WorkflowStateStore; cleanup?: () => void }) {
  describe(`WorkflowStateStore — ${label}`, () => {
    let store: WorkflowStateStore;
    let cleanup: (() => void) | undefined;

    beforeEach(() => {
      const f = factory();
      store = f.store;
      cleanup = f.cleanup;
    });
    afterEach(() => cleanup?.());

    it("round-trips a run record", async () => {
      await store.saveRun(sampleRun);
      expect(await store.loadRun("run-1")).toEqual(sampleRun);
    });

    it("returns null for missing run", async () => {
      expect(await store.loadRun("nope")).toBeNull();
    });

    it("listRuns filters by status", async () => {
      await store.saveRun({ ...sampleRun, runId: "r1", status: "running" });
      await store.saveRun({ ...sampleRun, runId: "r2", status: "completed" });
      const running = await store.listRuns({ status: "running" });
      expect(running.map((r) => r.runId).sort()).toEqual(["r1"]);
    });

    it("listRuns returns top-level records only (does not surface step keys)", async () => {
      await store.saveRun(sampleRun);
      // Save a step under the same runId — this creates a "wf:run-1:step:a" key
      // which must NOT show up as a separate run.
      const step: WorkflowStepRecord = {
        stepId: "a",
        status: "completed",
        attempts: 1,
        result: 42,
      };
      await store.saveStep("run-1", step);
      const all = await store.listRuns();
      expect(all.length).toBe(1);
      expect(all[0]!.runId).toBe("run-1");
    });

    it("definition persists per run", async () => {
      await store.saveDefinition("run-1", sampleDef);
      expect(await store.loadDefinition("run-1")).toEqual(sampleDef);
    });

    it("step records round-trip and listSteps returns all", async () => {
      await store.saveStep("run-1", {
        stepId: "a",
        status: "completed",
        attempts: 1,
        result: 1,
      });
      await store.saveStep("run-1", {
        stepId: "b",
        status: "running",
        attempts: 1,
      });
      const steps = await store.listSteps("run-1");
      expect(steps.map((s) => s.stepId).sort()).toEqual(["a", "b"]);
    });

    it("events are FIFO per type and consumed on take", async () => {
      await store.appendEvent({ runId: "run-1", type: "x", payload: 1, receivedAt: 1 });
      await store.appendEvent({ runId: "run-1", type: "y", payload: 2, receivedAt: 2 });
      await store.appendEvent({ runId: "run-1", type: "x", payload: 3, receivedAt: 3 });

      // Earliest "x" comes first.
      const e1 = await store.takeEvent("run-1", "x");
      expect(e1?.payload).toBe(1);
      const e2 = await store.takeEvent("run-1", "x");
      expect(e2?.payload).toBe(3);
      const e3 = await store.takeEvent("run-1", "x");
      expect(e3).toBeNull();

      // y is unaffected.
      const e4 = await store.takeEvent("run-1", "y");
      expect(e4?.payload).toBe(2);
    });

    it("deleteRun cleans up the run record + definition + steps + events", async () => {
      await store.saveRun(sampleRun);
      await store.saveDefinition("run-1", sampleDef);
      await store.saveStep("run-1", {
        stepId: "a",
        status: "completed",
        attempts: 1,
      });
      await store.appendEvent({ runId: "run-1", type: "x", payload: 1, receivedAt: 1 });

      await store.deleteRun("run-1");

      expect(await store.loadRun("run-1")).toBeNull();
      expect(await store.loadDefinition("run-1")).toBeNull();
      expect(await store.listSteps("run-1")).toEqual([]);
      expect(await store.takeEvent("run-1", "x")).toBeNull();
    });
  });
}

suite("MemoryKvBackend", () => ({
  store: new KvWorkflowStateStore(new MemoryKvBackend()),
}));

suite("FsTestKvBackend (filesystem portability check)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-store-"));
  return {
    store: new KvWorkflowStateStore(new FsTestKvBackend(dir)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});

describe("KvWorkflowStateStore wiring", () => {
  it("rejects KvBackends without list()", () => {
    const noList: KvBackend = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    };
    expect(() => new KvWorkflowStateStore(noList)).toThrow(/list/);
  });
});
