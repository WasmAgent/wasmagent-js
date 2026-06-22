import { KernelPool } from "./KernelPool.js";
import type { WasmKernel } from "./types.js";

function makeKernel(id = "k"): WasmKernel & { id: string; disposed: boolean } {
  return {
    id,
    disposed: false,
    async run() {
      return { output: undefined, logs: [], isFinalAnswer: false };
    },
    async reset() {},
    async [Symbol.asyncDispose]() {
      this.disposed = true;
    },
  };
}

function makePool(maxConcurrent: number) {
  let counter = 0;
  const kernels: ReturnType<typeof makeKernel>[] = [];
  const factory = async () => {
    const k = makeKernel(`k${counter++}`);
    kernels.push(k);
    return k;
  };
  return { pool: new KernelPool({ factory, maxConcurrent }), kernels };
}

describe("KernelPool", () => {
  test("acquire returns a kernel and registers it as active", async () => {
    const { pool } = makePool(2);
    const k = await pool.acquire("r1");
    expect(k).toBeDefined();
    expect(pool.activeCount).toBe(1);
  });

  test("acquire same rollout ID returns the same kernel (idempotent)", async () => {
    const { pool } = makePool(2);
    const k1 = await pool.acquire("r1");
    const k2 = await pool.acquire("r1");
    expect(k1).toBe(k2);
    expect(pool.activeCount).toBe(1);
  });

  test("release returns kernel to idle; size stays same", async () => {
    const { pool } = makePool(2);
    await pool.acquire("r1");
    expect(pool.activeCount).toBe(1);
    await pool.release("r1");
    expect(pool.activeCount).toBe(0);
    expect(pool.size).toBe(1); // idle but still alive
  });

  test("released kernel is reused by next acquire", async () => {
    const { pool, kernels } = makePool(1);
    await pool.acquire("r1");
    await pool.release("r1");
    const k2 = await pool.acquire("r2");
    expect(kernels).toHaveLength(1); // factory called only once
    expect(k2).toBe(kernels[0]);
  });

  test("blocks when at maxConcurrent; unblocks on release", async () => {
    const { pool } = makePool(1);
    const k1 = await pool.acquire("r1");

    let r2Resolved = false;
    const r2Promise = pool.acquire("r2").then((k) => {
      r2Resolved = true;
      return k;
    });

    // r2 should not have resolved yet
    await Promise.resolve();
    expect(r2Resolved).toBe(false);

    await pool.release("r1");
    const k2 = await r2Promise;
    expect(r2Resolved).toBe(true);
    expect(k2).toBe(k1); // same kernel handed off
  });

  test("concurrent acquires up to maxConcurrent all succeed immediately", async () => {
    const { pool } = makePool(5);
    const kernels = await Promise.all(Array.from({ length: 5 }, (_, i) => pool.acquire(`r${i}`)));
    expect(pool.activeCount).toBe(5);
    expect(new Set(kernels).size).toBe(5); // all distinct
  });

  test("release no-op for unknown rollout ID", async () => {
    const { pool } = makePool(2);
    await expect(pool.release("unknown")).resolves.toBeUndefined();
  });

  test("dispose cleans up all kernels and rejects pending waiters", async () => {
    const { pool, kernels } = makePool(1);
    await pool.acquire("r1"); // fills the slot

    const waitPromise = pool.acquire("r2");
    await pool[Symbol.asyncDispose]();

    await expect(waitPromise).rejects.toThrow("disposed");
    expect(kernels[0]!.disposed).toBe(true);
  });

  test("factory throws → acquire rejects", async () => {
    const pool = new KernelPool({
      factory: async () => {
        throw new Error("factory boom");
      },
      maxConcurrent: 2,
    });
    await expect(pool.acquire("r1")).rejects.toThrow("factory boom");
  });

  test("constructor rejects maxConcurrent < 1", () => {
    expect(() => new KernelPool({ factory: async () => makeKernel(), maxConcurrent: 0 })).toThrow(
      "≥ 1"
    );
  });
});
