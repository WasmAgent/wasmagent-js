/**
 * LazyObservationHandle example (B3).
 *
 * Demonstrates how parallel tool calls can be launched immediately and their
 * handles resolved later — zero blocking between dispatch and usage.
 *
 * Run with: node lazy-observations.js
 */

import { LazyObservationHandle } from "@agentkit-js/core";

// Simulate slow tool calls (e.g. API calls that take different amounts of time).
function slowTool(name, delayMs, result) {
  return new Promise((resolve) => setTimeout(() => resolve(result), delayMs));
}

// ── Launch all tools in parallel immediately ──────────────────────────────────
console.log("Launching 3 tool calls in parallel...");
const t0 = Date.now();

const weatherHandle = LazyObservationHandle.fromToolResult(
  slowTool("weather", 200, "Sunny, 22°C in Tokyo")
);
const newsHandle = LazyObservationHandle.fromToolResult(
  slowTool("news", 150, "Latest: AI breakthrough announced")
);
const stockHandle = LazyObservationHandle.fromToolResult(
  slowTool("stocks", 300, "AAPL: $182.50 (+1.2%)")
);

console.log(`All handles created in ${Date.now() - t0}ms (none blocked)`);
console.log(`weather resolved: ${weatherHandle.isResolved}`); // false — still pending

// ── Resolve all in parallel — total wait = max(200, 150, 300) = 300ms ─────────
const [weather, news, stocks] = await Promise.all([
  weatherHandle.resolve(),
  newsHandle.resolve(),
  stockHandle.resolve(),
]);

console.log(`All resolved in ${Date.now() - t0}ms (parallel, not serial)`);
console.log(`weather resolved: ${weatherHandle.isResolved}`); // true

// ── peek() is now safe (synchronous access after resolution) ─────────────────
console.log("\nResults via peek():");
console.log(`  Weather: ${weatherHandle.peek()}`);
console.log(`  News:    ${newsHandle.peek()}`);
console.log(`  Stocks:  ${stockHandle.peek()}`);

// ── Compare: if these were serial, they'd take 200+150+300=650ms ─────────────
console.log(`\nSerial would have taken: ~${200 + 150 + 300}ms`);
console.log(`Parallel took: ~${Date.now() - t0}ms`);
