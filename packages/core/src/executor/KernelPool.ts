/**
 * KernelPool — bounded concurrency pool for WasmKernel instances.
 *
 * Maintains up to maxConcurrent live kernel instances. Each rollout
 * acquires one by ID; the pool blocks until a slot is free, then
 * assigns an existing idle kernel or creates a new one via the factory.
 * On release the kernel is returned to the idle queue for reuse.
 *
 * Kernels are cleaned up via [Symbol.asyncDispose]() when the pool is
 * disposed or when a kernel errors past recovery.
 */

import type { WasmKernel } from "../executor/types.js";

export interface KernelPoolOptions {
  /** Factory that creates a fresh WasmKernel on demand. */
  factory: () => Promise<WasmKernel>;
  /** Hard cap on simultaneously active kernels. */
  maxConcurrent: number;
}

interface WaitEntry {
  resolve: (kernel: WasmKernel) => void;
  reject: (err: unknown) => void;
}

export class KernelPool {
  readonly #factory: () => Promise<WasmKernel>;
  readonly #maxConcurrent: number;

  /** Kernels currently assigned to a rollout ID. */
  readonly #active = new Map<string, WasmKernel>();
  /** Kernels returned and available for reuse. */
  readonly #idle: WasmKernel[] = [];
  /** Callers blocked waiting for a slot. */
  readonly #waitQueue: WaitEntry[] = [];

  constructor(opts: KernelPoolOptions) {
    if (opts.maxConcurrent < 1) throw new RangeError("maxConcurrent must be ≥ 1");
    this.#factory = opts.factory;
    this.#maxConcurrent = opts.maxConcurrent;
  }

  /** Total live kernels (active + idle). */
  get size(): number {
    return this.#active.size + this.#idle.length;
  }

  /** Number of active (checked-out) kernels. */
  get activeCount(): number {
    return this.#active.size;
  }

  /**
   * Acquire a kernel for the given rollout ID.
   *
   * If the rollout already holds a kernel, returns it again (idempotent).
   * If a slot is available (active < maxConcurrent), assigns one immediately.
   * Otherwise queues the caller and resolves when another rollout releases.
   */
  async acquire(rolloutId: string): Promise<WasmKernel> {
    const existing = this.#active.get(rolloutId);
    if (existing) return existing;

    if (this.#active.size < this.#maxConcurrent) {
      return this.#assignSlot(rolloutId);
    }

    return new Promise<WasmKernel>((resolve, reject) => {
      const entry: WaitEntry = {
        resolve: (kernel: WasmKernel) => {
          this.#active.set(rolloutId, kernel);
          resolve(kernel);
        },
        reject,
      };
      this.#waitQueue.push(entry);
    });
  }

  /**
   * Release the kernel held by the given rollout ID.
   *
   * The kernel is returned to the idle queue and the next waiter (if any)
   * is unblocked immediately. No-op if the rolloutId is not currently active.
   */
  async release(rolloutId: string): Promise<void> {
    const kernel = this.#active.get(rolloutId);
    if (!kernel) return;

    this.#active.delete(rolloutId);

    const waiter = this.#waitQueue.shift();
    if (waiter) {
      // Hand the kernel directly to the next waiter; it registers in #active
      // via the wrapped resolve added in acquire().
      waiter.resolve(kernel);
    } else {
      this.#idle.push(kernel);
    }
  }

  /**
   * Dispose all kernels (active and idle) and reject pending waiters.
   *
   * After dispose() the pool must not be used.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    // Reject all waiting callers.
    const err = new Error("KernelPool disposed");
    for (const w of this.#waitQueue.splice(0)) w.reject(err);

    // Dispose all live kernels concurrently.
    const all = [...this.#active.values(), ...this.#idle.splice(0)];
    this.#active.clear();
    await Promise.allSettled(all.map((k) => k[Symbol.asyncDispose]()));
  }

  async #assignSlot(rolloutId: string): Promise<WasmKernel> {
    const kernel = this.#idle.pop() ?? (await this.#factory());
    this.#active.set(rolloutId, kernel);
    return kernel;
  }
}
