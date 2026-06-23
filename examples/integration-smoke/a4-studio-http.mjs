/**
 * A4 (S3) integration smoke — start the local Studio HTTP server, poke
 * /api/rollup, /api/runs, and /, kill cleanly.
 */
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Build a tiny NDJSON event log fixture with two traces — one complete,
// one failed — so the rollup carries non-trivial numbers.
const fixture = [
  {
    eventId: "e1",
    event: {
      traceId: "T1",
      parentTraceId: null,
      timestampMs: 1000,
      channel: "status",
      event: "step_start",
      data: { step: 1 },
    },
  },
  {
    eventId: "e2",
    event: {
      traceId: "T1",
      parentTraceId: null,
      timestampMs: 1500,
      channel: "model",
      event: "model_done",
      data: {
        modelId: "x",
        step: 1,
        finishReason: "stop",
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 50,
        estimatedUsd: 0.012,
      },
    },
  },
  {
    eventId: "e3",
    event: {
      traceId: "T1",
      parentTraceId: null,
      timestampMs: 1700,
      channel: "text",
      event: "final_answer",
      data: { answer: "ok" },
    },
  },
  {
    eventId: "e4",
    event: {
      traceId: "T2",
      parentTraceId: null,
      timestampMs: 3000,
      channel: "status",
      event: "step_start",
      data: { step: 1 },
    },
  },
  {
    eventId: "e5",
    event: {
      traceId: "T2",
      parentTraceId: null,
      timestampMs: 3300,
      channel: "status",
      event: "error",
      data: { error: "boom" },
    },
  },
];

const fixturePath = join(tmpdir(), `WasmAgent'studio-smoke-${Date.now()}.ndjson`);
await writeFile(fixturePath, fixture.map((e) => JSON.stringify(e)).join("\n"), "utf8");

const cliBin = new URL("../../packages/cli/dist/index.js", import.meta.url).pathname;
const port = 4811;
const proc = spawn(process.execPath, [cliBin, "devtools", `--events-file=${fixturePath}`, `--port=${port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
let startupOutput = "";
proc.stdout.on("data", (b) => {
  startupOutput += String(b);
});
proc.stderr.on("data", (b) => {
  startupOutput += "[err] " + String(b);
});

// Wait for the server to advertise its address.
const startedAt = Date.now();
while (!startupOutput.includes(`http://localhost:${port}`) && Date.now() - startedAt < 5_000) {
  await new Promise((r) => setTimeout(r, 50));
}
if (!startupOutput.includes(`http://localhost:${port}`)) {
  proc.kill();
  throw new Error(`server didn't start in 5s: ${startupOutput}`);
}
console.log("[A4] startup:", startupOutput.split("\n")[0]);

try {
  const rollup = await (await fetch(`http://127.0.0.1:${port}/api/rollup`)).json();
  console.log("[A4] rollup:", JSON.stringify(rollup));
  if (rollup.totalRuns !== 2) throw new Error(`expected 2 runs, got ${rollup.totalRuns}`);
  if (rollup.completed !== 1) throw new Error(`expected 1 complete, got ${rollup.completed}`);
  if (rollup.failed !== 1) throw new Error(`expected 1 failed, got ${rollup.failed}`);
  if (Math.abs(rollup.totalCostUsd - 0.012) > 1e-6) throw new Error("wrong cost");
  if (rollup.totalInputTokens !== 200) throw new Error("wrong input tokens");

  const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
  if (!Array.isArray(runs) || runs.length !== 2) throw new Error("wrong runs count");
  const t1 = runs.find((r) => r.traceId === "T1");
  const t2 = runs.find((r) => r.traceId === "T2");
  if (t1.outcome !== "complete" || t1.finalAnswer !== "ok") throw new Error("t1 wrong");
  if (t2.outcome !== "failed" || t2.errorCount !== 1) throw new Error("t2 wrong");
  console.log("[A4] /api/rollup + /api/runs ✓");

  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  if (!html.includes("WasmAgent Studio") || !html.includes("/api/rollup")) {
    throw new Error("HTML page missing markers");
  }
  console.log("[A4] / HTML page ✓");

  const notFound = await fetch(`http://127.0.0.1:${port}/no-such-path`);
  if (notFound.status !== 404) throw new Error(`expected 404, got ${notFound.status}`);
  console.log("[A4] 404 fallthrough ✓");
} finally {
  proc.kill();
  await unlink(fixturePath).catch(() => undefined);
}

console.log("\n[A4] all integration checks passed");
process.exit(0);
