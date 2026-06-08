import { describe, expect, it } from "vitest";
import { LazyObservationHandle } from "../memory/LazyObservationHandle.js";

describe("LazyObservationHandle (B3)", () => {
  it("resolve() returns the value from the wrapped Promise", async () => {
    const handle = new LazyObservationHandle(Promise.resolve("hello"));
    expect(await handle.resolve()).toBe("hello");
  });

  it("isResolved is false before the promise settles", () => {
    let resolveOuter!: (v: string) => void;
    const p = new Promise<string>((res) => {
      resolveOuter = res;
    });
    const handle = new LazyObservationHandle(p);
    expect(handle.isResolved).toBe(false);
    resolveOuter("done");
  });

  it("isResolved is true after the promise settles", async () => {
    const handle = new LazyObservationHandle(Promise.resolve("x"));
    await handle.resolve();
    expect(handle.isResolved).toBe(true);
  });

  it("peek() returns the value after resolution", async () => {
    const handle = new LazyObservationHandle(Promise.resolve("peeked"));
    await handle.resolve();
    expect(handle.peek()).toBe("peeked");
  });

  it("peek() throws before resolution", () => {
    let _resolve!: (v: string) => void;
    const handle = new LazyObservationHandle(
      new Promise<string>((r) => {
        _resolve = r;
      })
    );
    expect(() => handle.peek()).toThrow("not yet resolved");
    _resolve("x");
  });

  it("peek() re-throws the rejection error after failed resolution", async () => {
    const handle = new LazyObservationHandle(Promise.reject(new Error("network failure")));
    await expect(handle.resolve()).rejects.toThrow("network failure");
    expect(() => handle.peek()).toThrow("network failure");
  });

  it("LazyObservationHandle.of() creates a pre-resolved handle", async () => {
    const handle = LazyObservationHandle.of("immediate");
    expect(await handle.resolve()).toBe("immediate");
  });

  it("LazyObservationHandle.fromToolResult() wraps a Promise", async () => {
    const toolPromise = Promise.resolve("tool result");
    const handle = LazyObservationHandle.fromToolResult(toolPromise);
    expect(await handle.resolve()).toBe("tool result");
  });

  it("factory function form is also accepted", async () => {
    const handle = new LazyObservationHandle(() => Promise.resolve("lazy factory"));
    expect(await handle.resolve()).toBe("lazy factory");
  });

  it("multiple awaits on the same handle return the same value", async () => {
    const handle = new LazyObservationHandle(Promise.resolve("idempotent"));
    const [a, b, c] = await Promise.all([handle.resolve(), handle.resolve(), handle.resolve()]);
    expect(a).toBe("idempotent");
    expect(b).toBe("idempotent");
    expect(c).toBe("idempotent");
  });
});
