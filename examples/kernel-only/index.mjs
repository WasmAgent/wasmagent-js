// Standalone usage of @wasmagent/kernel-quickjs.
//
// This example is intentionally minimal: it imports ONLY the kernel package.
// No CodeAgent, no ToolCallingAgent, no model adapter. The point is that the
// kernel packages are usable as composable WASM sandboxes from any agent
// framework — Vercel AI SDK, Mastra, LangGraph, your own — not just from
// the rest of agentkit-js.
//
// Run: node examples/kernel-only/index.mjs

import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

async function main() {
  const kernel = new QuickJSKernel();

  console.log("=== Sort an array inside QuickJS WASM ===");
  const sorted = await kernel.run(`
    const arr = [3, 1, 4, 1, 5, 9, 2, 6];
    arr.sort((a, b) => a - b);
    arr;
  `);
  console.log("output:", sorted.output);

  console.log("\n=== Capturing logs (console.log) ===");
  const logged = await kernel.run(`console.log("hello from inside QuickJS"); 42`);
  console.log("logs:", logged.logs);
  console.log("output:", logged.output);

  console.log("\n=== Sandboxed — no access to host globals ===");
  const sandboxed = await kernel.run(
    `({ hasProcess: typeof process, hasRequire: typeof require })`,
  );
  console.log("inside sandbox:", sandboxed.output);

  await kernel[Symbol.asyncDispose]?.();

  console.log("\n✓ kernel works standalone — no @wasmagent/core required.");
}

main().catch((err) => {
  console.error("kernel failed:", err);
  process.exit(1);
});
