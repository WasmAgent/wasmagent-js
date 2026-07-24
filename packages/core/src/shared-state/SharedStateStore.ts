/**
 * #135 — SharedStateStore
 *
 * Session-keyed store for human-agent collaborative state.
 * Supports in-memory (Map) or any KvBackend for persistence.
 * Per-session write serialization prevents interleaved dispatches.
 */

import type { KvBackend } from "../checkpoint/index.js";
import type { StateModel } from "./StateModel.js";

/** Metadata attached to every dispatch/replace call. */
export interface StoreMeta {
  source: string;
}

/** Event emitted on state changes. */
export interface ChangeEvent<S> {
  sessionId: string;
  state: S;
  action?: unknown;
  source: string;
}

/** Configuration options for SharedStateStore. */
export interface SharedStateStoreOpts {
  backend?: KvBackend;
  /** Maximum number of sessions to keep in memory (LRU eviction). Default: 1000. */
  maxSessions?: number;
}

/**
 * Session-keyed state store with pub/sub notification.
 * Thread-safe via per-session async lock (serializes concurrent dispatches).
 */
export class SharedStateStore<S, A extends { type: string }> {
  readonly #model: StateModel<S, A>;
  readonly #backend: KvBackend | undefined;
  readonly #memory: Map<string, S>;
  readonly #listeners: Map<string, Set<(evt: ChangeEvent<S>) => void>>;
  /** #198 — Listeners notified on changes to ANY session (UI synchronization). */
  readonly #globalListeners: Set<(evt: ChangeEvent<S>) => void>;
  readonly #locks: Map<string, Promise<void>>;
  readonly #accessOrder: Map<string, number>;
  readonly #maxSessions: number;
  #accessCounter: number;

  constructor(model: StateModel<S, A>, opts?: SharedStateStoreOpts) {
    this.#model = model;
    this.#backend = opts?.backend;
    this.#memory = new Map();
    this.#listeners = new Map();
    this.#globalListeners = new Set();
    this.#locks = new Map();
    this.#accessOrder = new Map();
    this.#maxSessions = opts?.maxSessions ?? 1000;
    this.#accessCounter = 0;
  }

  /** Access the underlying model (for projection/affordances). */
  get model(): StateModel<S, A> {
    return this.#model;
  }

  /** Get current state for a session. Initializes if not present. */
  async get(sessionId: string): Promise<S> {
    this.#touchAccess(sessionId);

    // Check in-memory cache first
    const cached = this.#memory.get(sessionId);
    if (cached !== undefined) return cached;

    // Try KV backend
    if (this.#backend) {
      const raw = await this.#backend.get(`shared-state:${sessionId}`);
      if (raw !== null) {
        const state = JSON.parse(raw) as S;
        this.#memory.set(sessionId, state);
        return state;
      }
    }

    // Initialize with model default
    const initial = this.#model.initial();
    this.#memory.set(sessionId, initial);
    if (this.#backend) {
      await this.#backend.put(`shared-state:${sessionId}`, JSON.stringify(initial));
    }
    return initial;
  }

  /** Dispatch an action to a session, returning the new state. */
  async dispatch(sessionId: string, action: A, meta: StoreMeta): Promise<S> {
    return this.#withLock(sessionId, async () => {
      const current = await this.get(sessionId);
      const next = this.#model.reduce(current, action);
      await this.#persist(sessionId, next);
      this.#notify(sessionId, next, action, meta.source);
      return next;
    });
  }

  /** Replace state wholesale (e.g. server-authoritative reset). */
  async replace(sessionId: string, next: S, meta: StoreMeta): Promise<S> {
    return this.#withLock(sessionId, async () => {
      await this.#persist(sessionId, next);
      this.#notify(sessionId, next, undefined, meta.source);
      return next;
    });
  }

  /** Subscribe to state changes for a session. Returns unsubscribe function. */
  subscribe(sessionId: string, listener: (evt: ChangeEvent<S>) => void): () => void {
    let set = this.#listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.#listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.#listeners.delete(sessionId);
    };
  }

  /**
   * #198 — Subscribe to state changes across ALL sessions.
   *
   * Unlike {@link subscribe}, which is scoped to a single known session, this
   * fires for every dispatch/replace regardless of sessionId. Intended for UI
   * synchronization layers (dashboards, devtools, transport bridges) that must
   * react to any change without tracking session IDs up front.
   *
   * The emitted {@link ChangeEvent} always carries `sessionId`, so global
   * listeners can route updates to the right component. Returns an unsubscribe
   * function.
   */
  subscribeToAll(listener: (evt: ChangeEvent<S>) => void): () => void {
    this.#globalListeners.add(listener);
    return () => {
      this.#globalListeners.delete(listener);
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async #persist(sessionId: string, state: S): Promise<void> {
    this.#memory.set(sessionId, state);
    this.#touchAccess(sessionId);
    this.#evictIfNeeded();
    if (this.#backend) {
      await this.#backend.put(`shared-state:${sessionId}`, JSON.stringify(state));
    }
  }

  #notify(sessionId: string, state: S, action: unknown | undefined, source: string): void {
    const perSession = this.#listeners.get(sessionId);
    // Nothing to do if no listeners at all — skip event construction.
    if (!perSession && this.#globalListeners.size === 0) return;

    const evt: ChangeEvent<S> = { sessionId, state, action, source };
    this.#fanout(perSession, evt);
    this.#fanout(this.#globalListeners, evt);
  }

  /** Invoke each listener, swallowing errors so one bad listener can't break the dispatch chain. */
  #fanout(listeners: Set<(evt: ChangeEvent<S>) => void> | undefined, evt: ChangeEvent<S>): void {
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(evt);
      } catch {
        // Listener errors are swallowed to avoid breaking the dispatch chain.
      }
    }
  }

  /** Per-session async lock via promise chaining. */
  async #withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(sessionId) ?? Promise.resolve();
    let resolve: (() => void) | undefined;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.#locks.set(sessionId, next);

    await prev;
    try {
      return await fn();
    } finally {
      resolve?.();
    }
  }

  #touchAccess(sessionId: string): void {
    this.#accessOrder.set(sessionId, ++this.#accessCounter);
  }

  #evictIfNeeded(): void {
    if (this.#memory.size <= this.#maxSessions) return;

    // Find oldest-access session and evict it
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, time] of this.#accessOrder) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.#memory.delete(oldestKey);
      this.#accessOrder.delete(oldestKey);
      // Note: we do NOT delete from backend (it's persistent storage)
    }
  }
}
