/**
 * Lazy observation handle (B3).
 *
 * Wraps a Promise<string> so the agent can reference a not-yet-complete tool
 * observation without blocking immediately on it.
 *
 * ── What is implemented ──────────────────────────────────────────────────────
 * Single-step parallel dispatch: ToolCallingAgent uses LazyObservationHandle
 * to launch all tool calls in a batch simultaneously (fromToolResult() for each),
 * then awaits them all via Promise.all(handles.map(h => h.resolve())).
 * This gives wall-clock = slowest single call rather than sum-of-all-calls.
 *
 * ── What is NOT implemented (@experimental) ──────────────────────────────────
 * The original B3 design also described "cross-step lazy references" — passing a
 * not-yet-resolved handle directly into MessageAssembler so it becomes part of
 * a future message prefix only when it finally resolves. MessageAssembler does
 * NOT currently await handles; it stores already-resolved string values.
 * peek() and isResolved are provided for this future use case but have no
 * callers in the current production path. Treat them as @experimental until
 * MessageAssembler.build() gains async support.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 * Parallel dispatch within one step:
 *   const handles = calls.map(c => LazyObservationHandle.fromToolResult(tools.call(c)));
 *   const results = await Promise.all(handles.map(h => h.resolve()));
 *
 * Pre-resolved (e.g. from cache):
 *   const handle = LazyObservationHandle.of("cached result");
 */
export class LazyObservationHandle {
  readonly #promise: Promise<string>;
  #resolved = false;
  #value: string | undefined;
  #error: unknown = undefined;

  constructor(source: Promise<string> | (() => Promise<string>)) {
    const p = typeof source === "function" ? source() : source;
    this.#promise = p.then(
      (v) => { this.#resolved = true; this.#value = v; return v; },
      (e) => { this.#resolved = true; this.#error = e; throw e; }
    );
  }

  /** Wait for the observation to complete and return its string value. */
  async resolve(): Promise<string> {
    return this.#promise;
  }

  /** True once the underlying promise has settled (fulfilled or rejected). */
  get isResolved(): boolean {
    return this.#resolved;
  }

  /**
   * Return the value synchronously without awaiting.
   * Throws if the handle has not yet resolved.
   */
  peek(): string {
    if (!this.#resolved) {
      throw new Error("LazyObservationHandle: not yet resolved — await handle.resolve() first");
    }
    if (this.#error !== undefined) {
      throw this.#error;
    }
    return this.#value!;
  }

  /** Creates a pre-resolved handle wrapping an already-known string value. */
  static of(value: string): LazyObservationHandle {
    return new LazyObservationHandle(Promise.resolve(value));
  }

  /** Creates a handle from a tool execution Promise. */
  static fromToolResult(p: Promise<string>): LazyObservationHandle {
    return new LazyObservationHandle(p);
  }
}
