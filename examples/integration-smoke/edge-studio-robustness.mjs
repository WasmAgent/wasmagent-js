/**
 * Edge integration smoke: Studio NDJSON + HTTP robustness.
 *
 * Drive `agentkit devtools` with malformed and degenerate event logs, then
 * probe the HTTP surface with concurrent, malformed, and large requests.
 */
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

const cliBin = new URL("../../packages/cli/dist/index.js", import.meta.url).pathname;

async function startStudio(events, port) {
  const path = join(tmpdir(), `edge-studio-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
  await writeFile(path, events, "utf8");

  const proc = spawn(process.execPath, [cliBin, "devtools", `--events-file=${path}`, `--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let stderr = "";
  proc.stdout.on("data", (b) => {
    buf += String(b);
  });
  proc.stderr.on("data", (b) => {
    stderr += String(b);
  });
  // Wait until either the server announces its address OR exits.
  const start = Date.now();
  while (!buf.includes(`http://localhost:${port}`) && proc.exitCode == null && Date.now() - start < 5_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { proc, path, startupOut: buf, startupErr: stderr };
}

async function stop(proc, path) {
  proc.kill();
  await unlink(path).catch(() => undefined);
}

// ── 1. Empty NDJSON file ─────────────────────────────────────────────────────

{
  const port = 4901;
  const { proc, path, startupOut } = await startStudio("", port);
  try {
    if (!startupOut.includes(`http://localhost:${port}`)) {
      fail("empty NDJSON: server did not start");
    } else {
      const rollup = await (await fetch(`http://127.0.0.1:${port}/api/rollup`)).json();
      if (rollup.totalRuns !== 0) fail("empty NDJSON: totalRuns should be 0", rollup);
      else ok("empty NDJSON: server starts, totalRuns=0");
    }
  } finally {
    await stop(proc, path);
  }
}

// ── 2. NDJSON with malformed lines mixed in ─────────────────────────────────

{
  const port = 4902;
  const lines = [
    JSON.stringify({
      eventId: "e1",
      event: {
        traceId: "T1", parentTraceId: null, timestampMs: 1000,
        channel: "status", event: "step_start", data: { step: 1 },
      },
    }),
    "{this is not valid json",
    "",
    JSON.stringify({
      eventId: "e2",
      event: {
        traceId: "T1", parentTraceId: null, timestampMs: 1500,
        channel: "text", event: "final_answer", data: { answer: "ok" },
      },
    }),
    "garbage line",
  ].join("\n");
  const { proc, path, startupOut, startupErr } = await startStudio(lines, port);
  try {
    if (!startupOut.includes(`http://localhost:${port}`)) {
      fail("malformed lines: server did not start", { out: startupOut, err: startupErr });
    } else {
      const rollup = await (await fetch(`http://127.0.0.1:${port}/api/rollup`)).json();
      if (rollup.totalRuns !== 1 || rollup.completed !== 1) {
        fail("malformed-lines NDJSON: should still aggregate the valid 2 events into 1 run", rollup);
      } else if (!/[Ss]kipping malformed/.test(startupErr)) {
        fail("malformed-lines: no warning logged for the bad lines", { startupErr });
      } else {
        ok("malformed-lines NDJSON: skipped + warned, valid runs aggregated");
      }
    }
  } finally {
    await stop(proc, path);
  }
}

// ── 3. Single very large event (1 MB JSON value) ────────────────────────────

{
  const port = 4903;
  const big = "x".repeat(1_000_000);
  const ev = JSON.stringify({
    eventId: "huge",
    event: {
      traceId: "TBIG", parentTraceId: null, timestampMs: 1000,
      channel: "text", event: "final_answer", data: { answer: big },
    },
  });
  const { proc, path } = await startStudio(ev, port);
  try {
    const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
    if (!Array.isArray(runs) || runs.length !== 1) {
      fail("1MB event: did not aggregate", runs);
    } else if (typeof runs[0].finalAnswer !== "string" || runs[0].finalAnswer.length !== 1_000_000) {
      fail("1MB event: finalAnswer truncated or missing", { len: runs[0].finalAnswer?.length });
    } else {
      ok("1MB single-event aggregation");
    }
  } finally {
    await stop(proc, path);
  }
}

// ── 4. Mixed-trace NDJSON in non-time order ─────────────────────────────────

{
  const port = 4904;
  const lines = [
    // Two interleaved traces, out of order.
    JSON.stringify({ eventId: "a1", event: { traceId: "A", parentTraceId: null, timestampMs: 3000, channel: "text", event: "final_answer", data: { answer: "A" } } }),
    JSON.stringify({ eventId: "b1", event: { traceId: "B", parentTraceId: null, timestampMs: 1000, channel: "status", event: "step_start", data: { step: 1 } } }),
    JSON.stringify({ eventId: "a0", event: { traceId: "A", parentTraceId: null, timestampMs: 2000, channel: "status", event: "step_start", data: { step: 1 } } }),
    JSON.stringify({ eventId: "b2", event: { traceId: "B", parentTraceId: null, timestampMs: 4000, channel: "status", event: "error", data: { error: "boom" } } }),
  ].join("\n");
  const { proc, path } = await startStudio(lines, port);
  try {
    const rollup = await (await fetch(`http://127.0.0.1:${port}/api/rollup`)).json();
    if (rollup.totalRuns !== 2 || rollup.completed !== 1 || rollup.failed !== 1) {
      fail("mixed-traces: wrong rollup", rollup);
    } else ok("mixed-traces NDJSON: 1 complete + 1 failed regardless of line order");
  } finally {
    await stop(proc, path);
  }
}

// ── 5. Concurrent HTTP requests ─────────────────────────────────────────────

{
  const port = 4905;
  // Build 50 small runs.
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(JSON.stringify({ eventId: `s${i}`, event: { traceId: `T${i}`, parentTraceId: null, timestampMs: 1000 + i, channel: "status", event: "step_start", data: { step: 1 } } }));
    lines.push(JSON.stringify({ eventId: `f${i}`, event: { traceId: `T${i}`, parentTraceId: null, timestampMs: 1500 + i, channel: "text", event: "final_answer", data: { answer: `r${i}` } } }));
  }
  const { proc, path } = await startStudio(lines.join("\n"), port);
  try {
    // Fire 20 concurrent requests at a mix of endpoints.
    const reqs = [];
    for (let i = 0; i < 20; i++) {
      const url = i % 2 === 0
        ? `http://127.0.0.1:${port}/api/runs`
        : `http://127.0.0.1:${port}/api/rollup`;
      reqs.push(fetch(url).then((r) => r.json()));
    }
    const results = await Promise.all(reqs);
    let bad = 0;
    for (const r of results) {
      if (Array.isArray(r)) {
        if (r.length !== 50) bad++;
      } else if (r && typeof r.totalRuns === "number") {
        if (r.totalRuns !== 50) bad++;
      } else bad++;
    }
    if (bad > 0) fail(`concurrent HTTP: ${bad}/20 responses wrong`);
    else ok("20 concurrent HTTP requests all consistent");
  } finally {
    await stop(proc, path);
  }
}

// ── 6. Unknown path returns 404, OPTIONS doesn't crash ─────────────────────

{
  const port = 4906;
  const { proc, path } = await startStudio("", port);
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/random/path`);
    if (r1.status !== 404) fail(`unknown path: got ${r1.status}, expected 404`);
    else ok("unknown path → 404");

    // OPTIONS preflight
    const r2 = await fetch(`http://127.0.0.1:${port}/api/rollup`, { method: "OPTIONS" });
    // Anything not a 5xx is acceptable — the server should not crash.
    if (r2.status >= 500) fail(`OPTIONS returned ${r2.status}`);
    else ok(`OPTIONS handled (status ${r2.status})`);
  } finally {
    await stop(proc, path);
  }
}

if (failed > 0) {
  console.error(`\n[edge-studio-robustness] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-studio-robustness] all checks passed`);
