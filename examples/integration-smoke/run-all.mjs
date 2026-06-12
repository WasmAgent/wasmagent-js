#!/usr/bin/env node
/**
 * Aggregate smoke runner — runs every script under
 * `examples/integration-smoke/` in series, reports pass/fail per script,
 * and exits non-zero if any failed.
 *
 * Each smoke script self-contains its assertions (see comments inside
 * each file) and exits with a non-zero code on failure. This runner
 * exists so a maintainer running `node run-all.mjs` from this directory
 * gets one bottom-line PASS/FAIL across the whole edge-test set.
 *
 * NOT part of CI: the suite spins up real worker_threads / WASM
 * isolates / HTTP servers and takes ~1–2 minutes wall-clock. CI gets
 * its fast feedback from `bun run test` (vitest) and
 * `examples/benchmarks/run-all.mjs` instead. This is the pre-merge /
 * pre-release sanity gate.
 *
 * Usage:
 *   cd examples/integration-smoke && bun run-all.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// We pin the order so the cheap, no-IO scripts run first — quick failure
// signal — and the heavyweight (Studio HTTP, MCP protocol) come last.
const ORDER = [
  "a5-openai-compat.mjs",
  "cross-kernel.mjs",
  "edge-capability-boundaries.mjs",
  "edge-sandbox-escape.mjs",
  "edge-state-pollution.mjs",
  "a2-aisdk-mastra.mjs",
  "edge-codemode-adversarial.mjs",
  "edge-cross-package.mjs",
  "a1-codemode.mjs",
  "edge-mcp-protocol.mjs",
  "edge-studio-robustness.mjs",
  "a4-studio-http.mjs",
];

// Sanity: every .mjs in this folder (except this runner) should be in ORDER.
const onDisk = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
  .sort();
const missing = onDisk.filter((f) => !ORDER.includes(f));
if (missing.length > 0) {
  console.error(
    `[run-all] WARNING: smoke script(s) not in ORDER list: ${missing.join(", ")}\n` +
      "  Add them to run-all.mjs's ORDER constant or remove them from disk."
  );
}

const results = [];
const overallStart = Date.now();

for (const file of ORDER) {
  if (!onDisk.includes(file)) {
    console.log(`[run-all] SKIP ${file} (file not on disk)`);
    continue;
  }
  const path = resolve(here, file);
  const start = Date.now();
  process.stdout.write(`[run-all] RUN  ${file} ... `);
  // We invoke `bun` rather than `node` because the smoke scripts use
  // workspace `@agentkit-js/*` imports — bun resolves those via
  // workspace symlinks; node would need an `--experimental-resolve` dance.
  const code = await new Promise((resolveFn) => {
    const p = spawn("bun", [path], {
      stdio: ["ignore", "pipe", "pipe"],
      // Keep cwd at the smoke folder so each script's relative imports
      // (e.g. ../../packages/cli/dist/index.js) resolve correctly.
      cwd: here,
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => {
      stdout += String(b);
    });
    p.stderr.on("data", (b) => {
      stderr += String(b);
    });
    // Hard wall-clock cap: 90s per script. The Studio scripts spin up an
    // HTTP server and hit it many times, which on a cold start can creep
    // up. Anything beyond 90s is a hang.
    const tm = setTimeout(() => {
      p.kill("SIGKILL");
    }, 90_000);
    p.on("exit", (c) => {
      clearTimeout(tm);
      // Stash the last 600 chars of stdout/stderr so we can show a hint
      // on failure without flooding the terminal.
      results.push({
        file,
        code: c ?? -1,
        ms: Date.now() - start,
        tail: (stderr || stdout).slice(-600),
      });
      resolveFn(c ?? -1);
    });
  });
  process.stdout.write(`${code === 0 ? "PASS" : "FAIL"} (${Date.now() - start}ms)\n`);
}

const elapsed = Date.now() - overallStart;
const failures = results.filter((r) => r.code !== 0);

console.log();
console.log("─".repeat(60));
for (const r of results) {
  console.log(`  ${r.code === 0 ? "✓" : "✗"} ${r.file.padEnd(34)} ${r.ms}ms`);
}
console.log("─".repeat(60));
console.log(`Summary: ${results.length - failures.length}/${results.length} passed  (${elapsed}ms)`);

if (failures.length > 0) {
  console.error();
  for (const f of failures) {
    console.error(`──── FAIL: ${f.file} (exit ${f.code}) ────`);
    console.error(f.tail);
  }
  process.exit(1);
}
