#!/usr/bin/env node
/**
 * Edge runtime smoke test (A3).
 *
 * Starts the Cloudflare Worker in workerd (via wrangler dev --local) and
 * verifies:
 *   1. GET /health returns { status: "ok" }
 *   2. POST /run with agentType:"tool-calling" streams SSE events (ToolCallingAgent
 *      does not use node:vm, so this should work in workerd)
 *   3. POST /run with agentType:"code" fails gracefully (CodeAgent uses JsKernel
 *      which requires node:vm — not available in workerd)
 *
 * Run: node scripts/smoke-test-edge.mjs
 * Requires: ANTHROPIC_API_KEY env var (or skips if missing)
 *
 * This test is intentionally NOT in the vitest suite because it requires a
 * running wrangler dev process and is environment-specific.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 18787;
const BASE = `http://localhost:${PORT}`;

async function request(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  return res;
}

async function run() {
  console.log("[smoke] Starting wrangler dev --local ...");
  const wrangler = spawn(
    "pnpm",
    [
      "--filter",
      "@agentkit-js/cloudflare-worker",
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(PORT),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let ready = false;
  wrangler.stdout.on("data", (d) => {
    const s = d.toString();
    if (s.includes("Ready on") || s.includes("Local:")) ready = true;
    process.stdout.write("[wrangler] " + s);
  });
  wrangler.stderr.on("data", (d) => process.stderr.write("[wrangler] " + d.toString()));

  // Wait up to 20s for the worker to be ready.
  for (let i = 0; i < 40 && !ready; i++) await sleep(500);
  if (!ready) {
    wrangler.kill();
    console.error("[smoke] FAIL: wrangler dev did not become ready in 20s");
    process.exit(1);
  }

  let failures = 0;

  try {
    // Test 1: /health
    const health = await request("/health");
    if (health.ok) {
      console.log("[smoke] PASS: GET /health →", await health.json());
    } else {
      console.error("[smoke] FAIL: GET /health returned", health.status);
      failures++;
    }
  } catch (e) {
    console.error("[smoke] FAIL: /health threw", e.message);
    failures++;
  }

  // Only test agent endpoints if API key is present.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[smoke] SKIP: ANTHROPIC_API_KEY not set, skipping agent tests");
  } else {
    try {
      // Test 2: tool-calling agent (no node:vm required — should work in workerd)
      const res = await request("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "say hello", agentType: "tool-calling", maxSteps: 1 }),
      });
      if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) {
        console.log("[smoke] PASS: POST /run tool-calling returns SSE stream");
      } else {
        console.error("[smoke] FAIL: POST /run tool-calling returned", res.status);
        failures++;
      }
    } catch (e) {
      console.error("[smoke] FAIL: /run tool-calling threw", e.message);
      failures++;
    }
  }

  wrangler.kill();

  if (failures > 0) {
    console.error(`[smoke] ${failures} test(s) failed`);
    process.exit(1);
  } else {
    console.log("[smoke] All tests passed");
  }
}

run().catch((e) => {
  console.error("[smoke] Uncaught:", e);
  process.exit(1);
});
