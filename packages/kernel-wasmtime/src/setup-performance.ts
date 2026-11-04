// fast-check 4.10.x accesses performance.now.bind(performance) at module load
// time. bun 1.3.14 passes the `typeof performance !== "undefined"` guard but
// the binding fails if performance is a getter that returns undefined in the
// test worker context. Polyfill here so fast-check initialises correctly.
if (typeof performance === "undefined" || typeof performance.now !== "function") {
  (globalThis as Record<string, unknown>).performance = {
    now: Date.now.bind(Date),
  };
}
