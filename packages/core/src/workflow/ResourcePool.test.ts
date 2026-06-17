/**
 * ResourcePool integration tests — covers the core promise: serial DAGs pay
 * no contention cost; parallel DAGs are gated correctly when pools are
 * configured.
 */

import { describe, expect, it } from "vitest";
import { InMemoryResourcePool } from "./ResourcePool.js";

describe("InMemoryResourcePool", () => {
  it("acquire on empty claim list returns immediately", async () => {
    const pool = new InMemoryResourcePool();
    const lease = await pool.acquire([]);
    lease.release();
  });

  it("default capacity is unbounded — sequential acquires never block", async () => {
    // Validates the design promise: an unconfigured pool imposes no cost.
    const pool = new InMemoryResourcePool();
    for (let i = 0; i < 100; i++) {
      const lease = await pool.acquire([{ key: "openai" }]);
      lease.release();
    }
    expect(pool.inspect().openai).toMatchObject({ inUse: 0, waiters: 0 });
  });

  it("does NOT serialize sequential acquires when capacity is set but no concurrent demand", async () => {
    // The user's mental model: serial tasks don't compete for resources.
    // Even with capacity=1, sequential acquire/release pairs run unblocked.
    const pool = new InMemoryResourcePool();
    pool.configure("gpu", { capacity: 1 });
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      const lease = await pool.acquire([{ key: "gpu" }]);
      lease.release();
    }
    expect(Date.now() - start).toBeLessThan(50); // No artificial waits.
  });

  it("serializes parallel acquires when capacity is exceeded", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("api", { capacity: 2 });
    const order: string[] = [];
    const tick = async (id: string, holdMs: number) => {
      const lease = await pool.acquire([{ key: "api" }]);
      order.push(`acq:${id}`);
      await new Promise((r) => setTimeout(r, holdMs));
      order.push(`rel:${id}`);
      lease.release();
    };
    await Promise.all([tick("a", 30), tick("b", 30), tick("c", 30), tick("d", 30)]);
    // First 2 acquires must come before any of c/d's acq events.
    const firstTwoAcq = order.slice(0, 2).filter((s) => s.startsWith("acq:"));
    expect(firstTwoAcq.length).toBe(2);
    // c and d's acq must come AFTER the first release.
    const firstRelease = order.findIndex((s) => s.startsWith("rel:"));
    const cAcq = order.indexOf("acq:c");
    const dAcq = order.indexOf("acq:d");
    expect(cAcq).toBeGreaterThan(firstRelease);
    expect(dAcq).toBeGreaterThan(firstRelease);
  });

  it("higher priority waiters jump the queue", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("scarce", { capacity: 1 });
    const lease0 = await pool.acquire([{ key: "scarce" }]);
    const order: string[] = [];
    const low = pool.acquire([{ key: "scarce" }], { priority: 0 }).then((l) => {
      order.push("low");
      l.release();
    });
    const high = pool.acquire([{ key: "scarce" }], { priority: 10 }).then((l) => {
      order.push("high");
      l.release();
    });
    // Give the queue a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    lease0.release();
    await Promise.all([low, high]);
    expect(order).toEqual(["high", "low"]);
  });

  it("rolls back partial acquisitions if any one is aborted", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("a", { capacity: 1 });
    pool.configure("b", { capacity: 1 });

    const heldA = await pool.acquire([{ key: "a" }]);
    // Now request both a and b — should hang on a, never grab b.
    const ac = new AbortController();
    const p = pool.acquire([{ key: "a" }, { key: "b" }], { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("user-cancel")), 10);
    await expect(p).rejects.toBeDefined();
    // b must not have been left in inUse=1 from a partial acquire.
    expect(pool.inspect().b?.inUse ?? 0).toBe(0);
    heldA.release();
  });

  it("merges duplicate keys by summing weights", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("net", { capacity: 3 });
    // Two claims on same key: 1 + 1 = 2 weight, capacity 3 → ok.
    const l = await pool.acquire([
      { key: "net", weight: 1 },
      { key: "net", weight: 1 },
    ]);
    expect(pool.inspect().net?.inUse).toBe(2);
    l.release();
    expect(pool.inspect().net?.inUse).toBe(0);
  });

  it("rejects claims whose weight exceeds configured capacity", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("tiny", { capacity: 2 });
    await expect(pool.acquire([{ key: "tiny", weight: 5 }])).rejects.toThrow(/exceeds capacity/);
  });

  it("lease timeout reclaims slots from stuck holders", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("locked", { capacity: 1, leaseMs: 30 });
    const stuck = await pool.acquire([{ key: "locked" }]);
    // Don't release stuck — wait for leaseMs to reclaim.
    const next = await pool.acquire([{ key: "locked" }]);
    next.release();
    stuck.release(); // No-op; already reclaimed.
    expect(pool.inspect().locked.inUse).toBe(0);
  });

  it("configure() drains waiters when capacity grows", async () => {
    const pool = new InMemoryResourcePool();
    pool.configure("growable", { capacity: 1 });
    const held = await pool.acquire([{ key: "growable" }]);
    let secondAcquired = false;
    const p = pool.acquire([{ key: "growable" }]).then((l) => {
      secondAcquired = true;
      l.release();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondAcquired).toBe(false);
    pool.configure("growable", { capacity: 2 }); // Bump capacity → drain waiter.
    await p;
    expect(secondAcquired).toBe(true);
    held.release();
  });
});
