#!/usr/bin/env node
/**
 * Run every benchmark in this directory and produce a single roll-up
 * report. CI calls this; non-zero exit means at least one README claim
 * deviates beyond its tolerance.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const benchmarks = [
  "ptc-tokens.mjs",
  "defer-loading.mjs",
  "input-examples.mjs",
  "context-editing.mjs",
  "parallel-agents.mjs",
  "cost-comparison.mjs",
];

let failed = 0;
for (const file of benchmarks) {
  const path = resolve(here, file);
  console.log(`\n──── ${file} ────`);
  await new Promise((res) => {
    const p = spawn(process.execPath, [path], { stdio: "inherit" });
    p.on("exit", (code) => {
      if (code !== 0) failed++;
      res();
    });
  });
}

if (failed > 0) {
  console.error(`\n❌ ${failed} benchmark(s) outside tolerance.`);
  process.exit(1);
}
console.log("\n✅ All benchmarks within tolerance.");
