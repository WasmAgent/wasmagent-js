#!/usr/bin/env node
/**
 * judge-roundtrip-ci.mjs — runs ONE swe-bench-lite task through the
 * judge container with a deliberately-empty patch.
 *
 * Invoked from .github/workflows/swe-bench-judge.yml. Designed to
 * verify the docker round-trip end-to-end without burning a model:
 *
 *   - Loads 1 task via the existing harness.
 *   - Builds the judge image (cached after first run).
 *   - Runs runTests(task, "") — an empty patch should not resolve.
 *   - Asserts the result has the expected well-typed shape.
 *   - Prints a one-line summary; exits non-zero if the wiring breaks.
 */

import { exit } from "node:process";

// Reuse the harness exports by import-ing it. The harness's CLI
// dispatch only fires when invoked as the main module, so importing
// is safe.
const harness = await import("./swe-bench-lite.mjs");
const { loadTasks, runTests } =
  /** @type {{loadTasks: (n: number) => Promise<unknown[]>, runTests: typeof import("./swe-bench-lite.mjs").runTests}} */ (
    /** @type {unknown} */ (harness)
  );

if (typeof loadTasks !== "function" || typeof runTests !== "function") {
  console.error("FATAL: swe-bench-lite.mjs did not export loadTasks / runTests.");
  console.error("If this changed intentionally, update judge-roundtrip-ci.mjs to match.");
  exit(2);
}

function parseArg(name, fallback = null) {
  for (const raw of process.argv.slice(2)) {
    if (raw === `--${name}` || raw === `-${name}`) return true;
    if (raw.startsWith(`--${name}=`)) return raw.slice(name.length + 3);
  }
  return fallback;
}

const tasksArg = Number.parseInt(String(parseArg("tasks", "1")), 10);
const instanceFilter = parseArg("instance", null);

const n = Number.isFinite(tasksArg) && tasksArg > 0 ? tasksArg : 1;

console.log(`[judge-roundtrip] loading ${n} task(s) from HF...`);
const tasks = await loadTasks(n);
const task =
  instanceFilter
    ? tasks.find((t) => t.instance_id === instanceFilter) ?? tasks[0]
    : tasks[0];
if (!task) {
  console.error("FATAL: loadTasks returned no tasks.");
  exit(2);
}
console.log(`[judge-roundtrip] task: ${task.instance_id} (${task.repo})`);

console.log(`[judge-roundtrip] running runTests with empty patch...`);
const result = await runTests(task, "");

// Shape assertions.
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
};

ok(typeof result === "object" && result !== null, "result is an object");
ok(typeof result.resolved === "boolean", "result.resolved is boolean");
ok(typeof result.applied === "boolean", "result.applied is boolean");
ok(
  result.fail_to_pass && Array.isArray(result.fail_to_pass.failed),
  "result.fail_to_pass.failed is array"
);
ok(
  result.pass_to_pass && Array.isArray(result.pass_to_pass.failed),
  "result.pass_to_pass.failed is array"
);
ok(Number.isFinite(result.wallMs) && result.wallMs >= 0, "result.wallMs is non-negative number");

// With an empty patch, the expected outcome is either:
//  - resolved: false, applied: false (most common — the test_patch
//    landed but the agent patch was empty, so fail_to_pass tests
//    still fail)
//  - resolved: false, error: "..." (clone failed, install failed, etc.)
ok(result.resolved === false, "empty-patch case yields resolved: false");

console.log("");
console.log("Summary:");
console.log(`  resolved: ${result.resolved}`);
console.log(`  applied:  ${result.applied}`);
console.log(`  fail_to_pass: passed=${result.fail_to_pass.passed.length} failed=${result.fail_to_pass.failed.length}`);
console.log(`  pass_to_pass: passed=${result.pass_to_pass.passed.length} failed=${result.pass_to_pass.failed.length}`);
console.log(`  wallMs:   ${result.wallMs}`);
if (result.error) console.log(`  error:    ${result.error.slice(0, 500)}`);

if (process.exitCode === 1) {
  console.error("\n[judge-roundtrip] FAILED — at least one shape assertion failed.");
  exit(1);
}
console.log("\n[judge-roundtrip] OK");
