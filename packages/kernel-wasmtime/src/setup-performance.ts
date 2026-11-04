// fast-check 4.10.x accesses performance.now.bind(performance) at module load
// time. bun 1.3.14 on GitHub Actions runners defines globalThis.performance
// but performance.now is undefined (non-configurable getter returns undefined
// in worker context). A plain assignment is silently dropped when the property
// is non-configurable, so we use Object.defineProperty to force the polyfill.
if (typeof performance === "undefined" || typeof performance.now !== "function") {
  try {
    Object.defineProperty(globalThis, "performance", {
      value: { now: Date.now.bind(Date) },
      writable: true,
      configurable: true,
    });
  } catch {
    // defineProperty itself failed (e.g. sealed object); fall back to direct
    // assignment, which is safe in environments that allow it.
    (globalThis as Record<string, unknown>).performance = {
      now: Date.now.bind(Date),
    };
  }
}
