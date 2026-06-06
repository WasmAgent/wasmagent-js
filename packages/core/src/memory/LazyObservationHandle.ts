/**
 * Lazy observation handle (B3).
 *
 * Wraps a Promise<string> so the agent can reference a not-yet-complete tool
 * observation in the next step without blocking on it. The handle resolves
 * transparently when awaited — callers never deal with raw Promises.
 *
 * Design:
 *   - `await handle.resolve()` — waits for the result and returns it.
 *   - `handle.isResolved` — true once the underlying promise has settled.
 *   - `handle.peek()` — returns the result synchronously (throws if not yet resolved).
 *   - Agents can pass handles directly into MessageAssembler; the assembler
 *     calls `await handle.resolve()` when building the next message list.
 *
 * Replaces the pattern of blocking on every tool result before yielding the
 * next step event — parallel tool calls can be launched speculatively and
 * their handles inserted into history immediately. Once the handle resolves,
 * its content becomes part of the stable message prefix.
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
