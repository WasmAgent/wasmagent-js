/**
 * ResourcePool — capacity-bounded semaphore with priority and lease timeout.
 *
 * Use cases:
 *   - Cap concurrent OpenAI requests at 5: pool.configure("openai", { capacity: 5 })
 *   - GPU jobs that take 2 of 4 slots: pool.acquire([{ key: "gpu", weight: 2 }])
 *   - Prevent deadlock if a holder crashes: leaseMs forces release after timeout
 *   - Prioritise interactive over batch jobs: priority parameter on acquire()
 *
 * Wire-up to Scheduler / WorkflowEngine: each step's resourceClaims are
 * acquire()'d before tool dispatch; release()'d on completion or failure.
 *
 * Backend interface allows future Redis / Durable Object implementations for
 * cross-process coordination. The shipped InMemoryResourcePool covers the
 * single-process case (worker + CLI), which fits >80% of users.
 */

export interface ResourceClaim {
  key: string;
  weight?: number;
}

export interface PoolConfig {
  /** Max simultaneous weight units in use. Default: Infinity (unbounded). */
  capacity?: number;
  /** Lease timeout in ms — after this, the holder is presumed dead and slots
   *  are reclaimed. Default: 0 (no timeout). */
  leaseMs?: number;
}

export interface AcquireOptions {
  /** Higher = served first when capacity frees up. Default: 0. */
  priority?: number;
  /** Abort signal — cancels the wait if the consumer no longer cares. */
  signal?: AbortSignal;
  /** Per-acquire override of leaseMs. */
  leaseMs?: number;
}

/** Opaque release handle returned by acquire(). */
export interface ResourceLease {
  /** Release all claims atomically. Idempotent. */
  release(): void;
}

export interface ResourcePool {
  configure(key: string, config: PoolConfig): void;
  /**
   * Acquire all claims atomically: either all are granted or none are.
   * Resolves once every claim has been admitted by its pool. Throws on
   * abort. Releasing the returned lease releases every claim in one shot.
   */
  acquire(claims: ResourceClaim[], opts?: AcquireOptions): Promise<ResourceLease>;
  /** Snapshot for debugging / observability. */
  inspect(): Record<string, { capacity: number; inUse: number; waiters: number }>;
}

// ── In-memory implementation ─────────────────────────────────────────────────

interface Waiter {
  weight: number;
  priority: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  cancelled: boolean;
}

interface Slot {
  capacity: number;
  inUse: number;
  /** Priority-ordered (desc) wait queue; head served first when capacity frees. */
  waiters: Waiter[];
  leaseMs: number;
}

export class InMemoryResourcePool implements ResourcePool {
  readonly #slots = new Map<string, Slot>();

  configure(key: string, config: PoolConfig): void {
    const slot = this.#getOrCreateSlot(key);
    if (config.capacity !== undefined) slot.capacity = config.capacity;
    if (config.leaseMs !== undefined) slot.leaseMs = config.leaseMs;
    // Capacity may have grown — try to admit waiters.
    this.#drain(key);
  }

  async acquire(claims: ResourceClaim[], opts: AcquireOptions = {}): Promise<ResourceLease> {
    if (claims.length === 0) return { release: () => {} };

    // Normalise: dedupe identical keys by summing weights so a step can't
    // double-acquire the same pool. Two claims on the same key with weights
    // 1 + 2 collapse to a single weight-3 claim.
    const merged = new Map<string, number>();
    for (const c of claims) {
      const w = c.weight ?? 1;
      if (w <= 0) continue;
      merged.set(c.key, (merged.get(c.key) ?? 0) + w);
    }

    const priority = opts.priority ?? 0;
    const acquired: { key: string; weight: number }[] = [];

    try {
      for (const [key, weight] of merged.entries()) {
        await this.#acquireOne(key, weight, priority, opts.signal);
        acquired.push({ key, weight });
      }
    } catch (err) {
      // Roll back any partially-acquired slots.
      for (const a of acquired) this.#releaseOne(a.key, a.weight);
      throw err;
    }

    // Lease timeout: per-acquire override falls back to per-pool config.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let released = false;

    const doRelease = () => {
      if (released) return;
      released = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const a of acquired) this.#releaseOne(a.key, a.weight);
    };

    // Per-acquire leaseMs takes precedence, otherwise use the max of the
    // touched pools' leaseMs settings (whichever holder is most likely to be
    // stuck triggers reclaim).
    let effectiveLease = opts.leaseMs ?? 0;
    if (!effectiveLease) {
      for (const a of acquired) {
        const slot = this.#slots.get(a.key);
        if (slot && slot.leaseMs > effectiveLease) effectiveLease = slot.leaseMs;
      }
    }
    if (effectiveLease > 0) {
      timer = setTimeout(() => {
        // Lease timed out: forcibly release. Users see an orphaned lease whose
        // .release() is a no-op (already released).
        if (!released) doRelease();
      }, effectiveLease);
    }

    return { release: doRelease };
  }

  inspect(): Record<string, { capacity: number; inUse: number; waiters: number }> {
    const out: Record<string, { capacity: number; inUse: number; waiters: number }> = {};
    for (const [key, slot] of this.#slots.entries()) {
      out[key] = {
        capacity: slot.capacity,
        inUse: slot.inUse,
        waiters: slot.waiters.length,
      };
    }
    return out;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #getOrCreateSlot(key: string): Slot {
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = {
        capacity: Number.POSITIVE_INFINITY,
        inUse: 0,
        waiters: [],
        leaseMs: 0,
      };
      this.#slots.set(key, slot);
    }
    return slot;
  }

  async #acquireOne(
    key: string,
    weight: number,
    priority: number,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const slot = this.#getOrCreateSlot(key);
    if (weight > slot.capacity) {
      throw new Error(
        `ResourcePool: claim weight ${weight} exceeds capacity ${slot.capacity} for "${key}"`
      );
    }

    // Fast path: enough room and no priority queue ahead of us.
    if (slot.waiters.length === 0 && slot.inUse + weight <= slot.capacity) {
      slot.inUse += weight;
      return;
    }

    // Wait. Insert into the queue at the position dictated by priority (desc, FIFO within tier).
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { weight, priority, resolve, reject, cancelled: false };
      const insertAt = slot.waiters.findIndex((w) => w.priority < priority);
      if (insertAt === -1) slot.waiters.push(waiter);
      else slot.waiters.splice(insertAt, 0, waiter);

      if (signal) {
        const onAbort = () => {
          waiter.cancelled = true;
          const idx = slot.waiters.indexOf(waiter);
          if (idx !== -1) slot.waiters.splice(idx, 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  #releaseOne(key: string, weight: number): void {
    const slot = this.#slots.get(key);
    if (!slot) return;
    slot.inUse = Math.max(0, slot.inUse - weight);
    this.#drain(key);
  }

  #drain(key: string): void {
    const slot = this.#slots.get(key);
    if (!slot) return;
    while (slot.waiters.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length>0 guarantees [0] exists
      const next = slot.waiters[0]!;
      if (next.cancelled) {
        slot.waiters.shift();
        continue;
      }
      if (slot.inUse + next.weight > slot.capacity) break;
      slot.waiters.shift();
      slot.inUse += next.weight;
      next.resolve();
    }
  }
}
