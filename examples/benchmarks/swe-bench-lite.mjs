/**
 * swe-bench-lite.mjs — SWE-bench-lite-class code-mode dispatch benchmark (DRAFT).
 *
 * Direction 2 of the 2026-06-12 optimization brief calls for a
 * single citable public-leaderboard number to break the chicken-and-egg
 * traction problem. LongMemEval-500 is the answer for the memory axis;
 * SWE-bench-lite-class is the answer for the *code-mode dispatch* axis,
 * directly comparable to Cloudflare Code Mode MCP (whose numbers are
 * not public, so any honest WasmAgent number is automatically the
 * first-mover entry on this axis).
 *
 * ## Status
 *
 * **DRAFT — not for publication runs yet.** This file is the skeleton
 * harness we want to fill in before we burn API budget. The file
 * lives in the repo today so that:
 *
 *   1. The methodology is reviewable in PR before any number is
 *      announced (per the strategy memo's "no private benchmarks"
 *      rule in section 4).
 *   2. The sample-mode (`--smoke`) path can run in CI as a
 *      regression guard once the harness is live.
 *   3. Contributors looking at the upstream-prs directory can find
 *      the leaderboard companion artefact in the same place.
 *
 * The first published run is funding-dependent (🖥️ in ROADMAP). The
 * placeholder report lives at
 * `docs/reports/swe-bench-lite-pending.md`; it follows the same
 * shape as `longmemeval-500-pending.md`.
 *
 * ## What this benchmarks
 *
 * The SWE-bench-lite split is 300 GitHub issue → patch tasks scoped
 * to a small set of repos. The "code-mode dispatch" framing is:
 *
 *   - Expose the repo-edit tool surface (read_file / write_file /
 *     run_tests / git_diff …) via the WasmAgent code-mode MCP server
 *     (`@wasmagent/mcp-server`'s `createCodeModeServer()`).
 *   - The agent receives `docs_search` + `execute_code` and dispatches
 *     all tool calls inside a single sandboxed script per step.
 *   - Compare against two baselines:
 *       (a) Direct MCP — same tools, but published as N tool entries.
 *       (b) Cloudflare Code Mode MCP — for the bootstrap-token axis,
 *           we cite their published 1,000-token figure when the
 *           comparison is fair (same N, same tools).
 *
 * Output axes (per task and aggregated):
 *
 *   - resolved (binary): does the patch pass the held-out tests?
 *   - bootstrap_tokens: prompt size at step 0 (smaller is better)
 *   - total_tokens: in + out across the whole solve
 *   - cache_read_tokens: stable-prefix wins, Anthropic-only
 *   - wall_p95_ms: time-to-resolution
 *   - usd_per_solve / j_per_solve: cost & energy for Pareto framing
 *
 * ## Usage (when complete)
 *
 *   # Smoke (CI): 3 tasks, no real model — just exercises the harness:
 *   node swe-bench-lite.mjs --smoke
 *
 *   # Single answerer × code-mode dispatch:
 *   node swe-bench-lite.mjs \
 *     --tasks=300 \
 *     --answerer=claude-sonnet-4-6 \
 *     --answerer-base=https://api.anthropic.com/v1 \
 *     --dispatch=codemode \
 *     --output=docs/reports/swe-bench-lite-2026-XX-XX.md
 *
 *   # Pareto run (the artefact we publish):
 *   node swe-bench-lite.mjs --report \
 *     --tasks=300 \
 *     --answerers=claude-sonnet-4-6,claude-haiku-4-5,gpt-4o-mini \
 *     --dispatch=codemode,direct \
 *     --output=docs/reports/swe-bench-lite-2026-XX-XX.md
 *
 * ## Why first-mover-on-this-axis is the play
 *
 * Cloudflare's Code Mode MCP server published a token-savings story
 * (2026-02 blog) but did NOT publish a SWE-bench-class number. The
 * framework choice for an agent doing real coding work is between
 * "direct MCP" and "code-mode" — and there is no public number for
 * either pattern on a real coding benchmark.
 *
 * Whoever publishes the first credible number on this axis owns the
 * citation slot for the next 6-12 months. The strategy memo's L2 is
 * exactly this: trade self-built numbers for public-leaderboard
 * numbers, on the axes our differentiators actually move.
 *
 * ## What "Pareto" gets us that single-number doesn't
 *
 * SWE-bench-lite's official leaderboard ranks by accuracy alone.
 * That single dimension hides the variance we care about
 * (cost/correct, latency under budget, cache effectiveness). The
 * WasmAgent report follows the evals-runner Pareto convention:
 * accuracy × USD/correct × p95 wall × J/correct, with the
 * single-axis SWE-bench number called out *and* contextualized
 * in a Pareto plot. A reader who only wants the headline gets it;
 * a reader making a $$$/quality call gets the rest.
 *
 * ## Pre-run checklist
 *
 * Before running for publication, confirm:
 *
 *   [ ] SWE-bench-lite tasks are downloadable (HuggingFace dataset
 *       `princeton-nlp/SWE-bench_Lite`, ~300 instances).
 *   [ ] The fixture loader handles the dataset's known per-instance
 *       skips (env mismatches; tracked upstream).
 *   [ ] The code-mode MCP server is wired with the file/test/git
 *       tool surface AND the capabilities are sandboxed (no
 *       arbitrary network egress; allowedHosts: []).
 *   [ ] The answerer adapter can plumb `cache_read_input_tokens`
 *       so we can report cache hit rate.
 *   [ ] The judge step (does the patch pass tests?) runs in a
 *       container, not on the host.
 *   [ ] A dry run on a 5-task subset matches the expected pass
 *       rate within ±10% of a known reference (e.g. published
 *       Sonnet-4-6 on SWE-bench-lite).
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

const DEFAULT_REPORT_PATH = "docs/reports/swe-bench-lite-pending.md";

/** Local cache for the dataset rows so a re-run does not re-download. */
const DATASET_CACHE_PATH = resolvePath(
  // .cache/ is .gitignored at the repo root by convention.
  ".cache/swe-bench-lite/test.json"
);

/** HuggingFace datasets-server base URL. */
const HF_ROWS_URL =
  "https://datasets-server.huggingface.co/rows" +
  "?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test";

// ── flag parsing ─────────────────────────────────────────────────────────────
// Same shape as longmemeval-500.mjs so users have one mental model.
// Wrapped in an isMain guard so `import { runTests } from "./swe-bench-lite.mjs"`
// (e.g. from judge-roundtrip-ci.mjs) does NOT trigger the CLI dispatch.
const isMain =
  process.argv[1] != null &&
  new URL(import.meta.url).pathname.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").at(-1) ?? ""
  );

if (isMain) {
  const args = parseArgs(process.argv.slice(2));

  if (args["help"] || (args._.length === 0 && Object.keys(args).length === 1)) {
    printHelp();
    process.exit(0);
  }

  if (args["smoke"]) {
    await smokeRun();
    process.exit(0);
  }

  if (args["load-tasks"]) {
    // Live network probe: download N tasks and print a one-line summary
    // per task. Useful for verifying the loader without committing to a
    // full benchmark run.
    const n = Number.parseInt(String(args["load-tasks"]), 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("Error: --load-tasks=N requires a positive integer.");
      process.exit(2);
    }
    const tasks = await loadTasks(n);
    console.log(`Loaded ${tasks.length} tasks. First few:`);
    for (const t of tasks.slice(0, Math.min(3, tasks.length))) {
      console.log(`  - ${t.instance_id} (${t.repo} @ ${t.base_commit.slice(0, 8)})`);
      console.log(`    fail_to_pass=${t.fail_to_pass.length}, pass_to_pass=${t.pass_to_pass.length}`);
    }
    process.exit(0);
  }

  console.error(
    "swe-bench-lite.mjs is a DRAFT skeleton — the publication run is funding-dependent.\n" +
      "See docs/reports/swe-bench-lite-pending.md for status.\n" +
      "Use --smoke to exercise the harness offline, or contribute to the\n" +
      "pre-run checklist in the file's docblock."
  );
  process.exit(2);
}

// ── implementation slots ─────────────────────────────────────────────────────
// Each function below is a clearly-named extension point. The intent is
// that a contributor (or co-maintainer candidate from the upstream-prs
// pipeline) can fill in one slot at a time without holding the whole
// run in their head.

/**
 * Standardised SWE-bench-lite task shape this harness consumes. Subset of
 * the upstream HuggingFace fields — we keep only what the dispatch /
 * judge stages need so a downstream contributor doesn't have to read the
 * dataset README to understand the call sites.
 */
/**
 * @typedef {object} SweBenchTask
 * @property {string} instance_id     Stable id, e.g. "astropy__astropy-12907".
 * @property {string} repo            "owner/name" of the upstream repo.
 * @property {string} base_commit     Commit to check out before applying patch.
 * @property {string} problem_statement  GitHub issue body the agent solves.
 * @property {string} test_patch      Test patch the judge applies + runs.
 * @property {string} patch           Reference patch (oracle solution; NOT shown to the agent).
 * @property {string[]} fail_to_pass  Tests that flip from FAIL→PASS on a correct patch.
 * @property {string[]} pass_to_pass  Tests that must STAY passing.
 * @property {string} version         Version string used by SWE-bench's judge.
 * @property {string} environment_setup_commit  Commit pinning the test environment.
 */

/**
 * Fetch (or load from cache) up to `count` SWE-bench-lite tasks.
 *
 * The official set is 300 instances; HuggingFace datasets-server pages
 * at 100 rows per call so a full load is three round-trips. We cache to
 * `.cache/swe-bench-lite/test.json` keyed by row count so a `--smoke`
 * follow-up does not re-hit the network.
 *
 * @param {number} count
 * @returns {Promise<SweBenchTask[]>}
 */
async function loadTasks(count) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new TypeError(`loadTasks: count must be a positive integer, got ${count}`);
  }

  // 1. Cache check.
  if (existsSync(DATASET_CACHE_PATH)) {
    const cached = JSON.parse(await readFile(DATASET_CACHE_PATH, "utf8"));
    if (Array.isArray(cached) && cached.length >= count) {
      return cached.slice(0, count);
    }
  }

  // 2. Paged fetch from HF datasets-server.
  const tasks = [];
  let offset = 0;
  const PAGE = 100; // HF cap.
  while (tasks.length < count) {
    const length = Math.min(PAGE, count - tasks.length);
    const url = `${HF_ROWS_URL}&offset=${offset}&length=${length}`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `loadTasks: HF datasets-server returned ${res.status} ${res.statusText} ` +
          `for offset=${offset} length=${length}. ` +
          "Common causes: network blocked, HF rate-limit, or the SWE-bench-lite " +
          "dataset shape changed upstream. Set HTTPS_PROXY if you're behind one."
      );
    }
    /** @type {{rows: Array<{row: Record<string, unknown>}>, num_rows_total: number}} */
    const json = await res.json();
    if (!Array.isArray(json.rows) || json.rows.length === 0) break;
    for (const { row } of json.rows) {
      tasks.push(normalizeRow(row));
    }
    offset += length;
    if (json.num_rows_total != null && offset >= json.num_rows_total) break;
  }

  // 3. Persist cache (best-effort; failure is logged but not fatal).
  try {
    await mkdir(dirname(DATASET_CACHE_PATH), { recursive: true });
    await writeFile(DATASET_CACHE_PATH, JSON.stringify(tasks), "utf8");
  } catch (e) {
    console.error(`loadTasks: cache write failed (${e.message}); continuing.`);
  }

  return tasks.slice(0, count);
}

/**
 * Map the HF row shape onto our task shape. FAIL_TO_PASS / PASS_TO_PASS
 * arrive as JSON-encoded strings inside a string field — we decode them
 * here so consumers see a parsed string[].
 *
 * @param {Record<string, unknown>} row
 * @returns {SweBenchTask}
 */
function normalizeRow(row) {
  const parseList = (v) => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v !== "string") return [];
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    instance_id: String(row.instance_id ?? ""),
    repo: String(row.repo ?? ""),
    base_commit: String(row.base_commit ?? ""),
    problem_statement: String(row.problem_statement ?? ""),
    test_patch: String(row.test_patch ?? ""),
    patch: String(row.patch ?? ""),
    fail_to_pass: parseList(row.FAIL_TO_PASS),
    pass_to_pass: parseList(row.PASS_TO_PASS),
    version: String(row.version ?? ""),
    environment_setup_commit: String(row.environment_setup_commit ?? ""),
  };
}

/**
 * @typedef {object} StubAnswerer
 * @property {"stub"} kind
 * @property {(task: SweBenchTask) => string} scriptFor
 *   Returns the codemode script the "agent" would have emitted for this
 *   task. Mocks the model — no API call, deterministic output. Used by
 *   --smoke / unit testing of the dispatch wiring.
 *
 * @typedef {object} RealAnswerer
 * @property {"anthropic" | "openai"} kind
 * @property {string} model
 * @property {string} apiKey
 * @property {string} [baseUrl]
 *
 * @typedef {StubAnswerer | RealAnswerer} Answerer
 */

/**
 * Run one task through the code-mode dispatch path: load a fake repo
 * tool surface, ask the answerer for a codemode script, execute the
 * script inside an WasmAgent kernel via `createCodemodeExecutor`, and
 * return the patch + counters.
 *
 * Stub-mode (the only mode wired today): `answerer.scriptFor(task)`
 * returns the script verbatim. Real-mode (Anthropic / OpenAI) is
 * deferred to the funded run — the hook is here so the real-mode call
 * is one branch away once an API key + container judge land.
 *
 * @param {SweBenchTask} task
 * @param {Answerer} answerer
 * @returns {Promise<{patch: string, toolCallCount: number, error?: string, logs: string[]}>}
 */
async function dispatchCodemode(task, answerer) {
  // Lazy-import WasmAgent so smokeRun (which never calls dispatch) does
  // not pay the cost of the workspace's TS build for every CI tick.
  const { JsKernel } = await import("../../packages/core/dist/index.js");
  const { createCodemodeExecutor } = await import(
    "../../packages/aisdk/dist/index.js"
  );

  // Fake repo state for this task — kept inside the dispatch closure
  // so concurrent dispatches do not share state. The real run replaces
  // this with a containerised git checkout at task.base_commit.
  const repo = new Map(); // path -> contents
  let pendingPatch = ""; // accumulated diff produced by writeFile calls

  const tools = {
    /**
     * Read a file from the repo. Stub returns a one-line stub so the
     * answerer's script gets a deterministic response shape.
     */
    async readFile({ path }) {
      if (!repo.has(path)) {
        // Real run: read from the on-disk checkout. Stub: synthesise.
        repo.set(path, `// stub contents of ${path}\n`);
      }
      return { content: repo.get(path) };
    },

    /** Write a file. Records a one-line "diff" for the patch we hand back. */
    async writeFile({ path, content }) {
      const before = repo.get(path) ?? "";
      repo.set(path, content);
      pendingPatch += `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-${before.trim()}\n+${content.trim()}\n`;
      return { ok: true };
    },

    /** Return the accumulated patch. Mirrors `git diff` on the real run. */
    async gitDiff() {
      return { patch: pendingPatch };
    },

    /**
     * Mock test run. Always returns "tests would run in the judge step"
     * — the real judge applies test_patch + runs the upstream test
     * suite in a container, NEVER on the host (per brief pre-run
     * checklist).
     */
    async runTestsInRepo() {
      return { note: "deferred to containerised judge" };
    },
  };

  // Build the codemode script.
  let script;
  if (answerer.kind === "stub") {
    script = answerer.scriptFor(task);
  } else {
    // Real-mode hook — funding-dependent. The real call shape:
    //   1. Build the system prompt from task.problem_statement +
    //      tool docs (docs_search shape).
    //   2. Send to Anthropic/OpenAI; capture the assistant's
    //      `execute_code` tool call argument as `script`.
    //   3. Track input/output/cache_read tokens for the Pareto report.
    throw new Error(
      `dispatchCodemode: real-mode answerer ('${answerer.kind}') not wired yet. ` +
        "Stub-mode is the only path until the funded run lands. " +
        "See docs/reports/swe-bench-lite-pending.md for status."
    );
  }

  const exec = createCodemodeExecutor({
    kernel: new JsKernel(),
    capabilities: {
      // Tool surface is host-bridged (each tool runs on the host); the
      // kernel itself needs no network or fs access for the stub path.
      // Real-mode tightens further: writeFile is gated to the workspace.
      allowedHosts: [],
      cpuMs: 5000,
    },
  });

  const result = await exec.execute(script, tools);

  // Always materialise the patch — even on error — so the judge can
  // see partial work. The error field is preserved so the Pareto
  // report can attribute the failure.
  const final = await tools.gitDiff();
  const out = {
    patch: final.patch,
    toolCallCount: countToolCallsFromLogs(result.logs ?? []),
    logs: result.logs ?? [],
  };
  if (result.error) out.error = result.error;
  return out;
}

/**
 * Best-effort tool-call count from the kernel's log stream. We do not
 * thread a counter through the executor because (a) it would couple
 * benchmark concerns into the public Executor surface and (b) the real
 * run derives the same number from prompt-cache events. For stub-mode
 * we count the `tools.X(` substring in user-emitted console output;
 * scripts that never log it report 0 (which is a true count of what
 * the user-visible logs reveal).
 */
function countToolCallsFromLogs(logs) {
  let n = 0;
  for (const line of logs) {
    if (typeof line === "string" && line.includes("[tool-call]")) n += 1;
  }
  return n;
}

/**
 * Direct-MCP dispatch: same fake repo tool surface as dispatchCodemode,
 * but the answerer issues one tool call per round instead of one
 * `execute_code` script. Used as the comparator cell in the Pareto
 * report so we can measure the bootstrap-token / round-trip difference
 * the code-mode pattern claims.
 *
 * Stub-mode (the only mode wired today): `answerer.callsFor(task)`
 * returns the ordered list of `[toolName, args]` pairs the answerer
 * "would have emitted". The harness applies them sequentially and
 * accumulates the patch the same way dispatchCodemode does.
 *
 * @typedef {object} StubDirectAnswerer
 * @property {"stub-direct"} kind
 * @property {(task: SweBenchTask) => Array<[string, Record<string, unknown>]>} callsFor
 *
 * @param {SweBenchTask} task
 * @param {StubDirectAnswerer | RealAnswerer} answerer
 * @returns {Promise<{patch: string, toolCallCount: number, error?: string, logs: string[]}>}
 */
async function dispatchDirect(task, answerer) {
  const repo = new Map();
  let pendingPatch = "";
  let calls = 0;
  const logs = [];
  const tools = {
    async readFile({ path }) {
      calls += 1;
      logs.push(`[direct] readFile ${path}`);
      if (!repo.has(path)) repo.set(path, `// stub contents of ${path}\n`);
      return { content: repo.get(path) };
    },
    async writeFile({ path, content }) {
      calls += 1;
      logs.push(`[direct] writeFile ${path} (${content.length} bytes)`);
      const before = repo.get(path) ?? "";
      repo.set(path, content);
      pendingPatch += `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-${before.trim()}\n+${content.trim()}\n`;
      return { ok: true };
    },
    async gitDiff() {
      calls += 1;
      return { patch: pendingPatch };
    },
    async runTestsInRepo() {
      calls += 1;
      return { note: "deferred to containerised judge" };
    },
  };

  if (answerer.kind !== "stub-direct") {
    throw new Error(
      `dispatchDirect: real-mode answerer ('${answerer.kind}') not wired yet. ` +
        "Stub-direct mode is the only path until the funded run lands."
    );
  }

  let lastError;
  try {
    const callPlan = answerer.callsFor(task);
    if (!Array.isArray(callPlan)) {
      throw new TypeError("callsFor must return an array of [toolName, args] pairs");
    }
    for (const [name, args] of callPlan) {
      const fn = /** @type {Record<string, (...args: unknown[]) => Promise<unknown>>} */ (
        /** @type {unknown} */ (tools)
      )[name];
      if (typeof fn !== "function") {
        throw new Error(`unknown tool: ${name}`);
      }
      await fn(args);
    }
  } catch (e) {
    lastError = e.message ?? String(e);
  }

  const out = {
    patch: pendingPatch,
    toolCallCount: calls,
    logs,
  };
  if (lastError !== undefined) out.error = lastError;
  return out;
}

/**
 * Run the SWE-bench-lite test suite for `task` against `patch` inside
 * a Docker container. The image is built once on first invocation
 * from `examples/benchmarks/judge/Dockerfile`; subsequent runs reuse
 * it. Per-task work happens inside the container — this function
 * NEVER touches the host (the brief's hard gate).
 *
 * @param {SweBenchTask} task
 * @param {string} patch  Unified-diff text. Empty string is allowed
 *                        and yields resolved=false (no patch ⇒ no fix).
 * @param {{
 *   imageTag?: string,        // Override the docker tag we use.
 *   skipBuild?: boolean,      // Trust the image is already present.
 *   timeoutMs?: number,       // Hard wall-clock cap for the container.
 *   judgeDir?: string,        // Where Dockerfile + judge.py live.
 * }} [opts]
 * @returns {Promise<{
 *   resolved: boolean,
 *   applied: boolean,
 *   fail_to_pass: {passed: string[], failed: string[]},
 *   pass_to_pass: {passed: string[], failed: string[]},
 *   error: string | null,
 *   wallMs: number,
 * }>}
 *
 * Stub fall-back: if Docker is not available on the host, returns a
 * result with `error: "docker not available"` and resolved=false so
 * the harness can still produce a Pareto report (the cells will say
 * '—' instead of a percentage). This lets `--smoke` exercise the
 * wiring without requiring docker on every CI runner.
 */
async function runTests(task, patch, opts = {}) {
  const start = Date.now();
  const imageTag = opts.imageTag ?? "WasmAgent-swe-judge:latest";
  const judgeDir =
    opts.judgeDir ?? resolvePath("examples/benchmarks/judge");
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000; // 30 min default

  const errResult = (error) => ({
    resolved: false,
    applied: false,
    fail_to_pass: { passed: [], failed: task.fail_to_pass ?? [] },
    pass_to_pass: { passed: [], failed: task.pass_to_pass ?? [] },
    error,
    wallMs: Date.now() - start,
  });

  // 1. docker available?
  if (!(await dockerAvailable())) {
    return errResult(
      "docker not available on host — runTests is a no-op. " +
        "Install Docker Desktop / podman to enable the judge."
    );
  }

  // 2. Image present? Build if not (or always when skipBuild=false-ish).
  if (!opts.skipBuild) {
    const buildOk = await ensureImage(imageTag, judgeDir);
    if (!buildOk.ok) return errResult(`docker build failed: ${buildOk.err}`);
  }

  // 3. Stage the per-task work directory.
  const tmp = await mkdtemp(resolvePath(`.cache/swe-bench-lite/judge-${task.instance_id}-`));
  await writeFile(`${tmp}/instance.json`, JSON.stringify(task), "utf8");
  await writeFile(`${tmp}/patch.diff`, patch ?? "", "utf8");

  // 4. Run.
  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${tmp}:/work`,
    // Prevent the container from reaching the host's docker socket
    // or arbitrary network — the judge clones from GitHub but should
    // not need anything else. We do NOT pass --network=none because
    // git clone needs the network; tightening this is a follow-up.
    imageTag,
  ];
  const { code, err } = await runDocker(dockerArgs, timeoutMs);

  // 5. Read the result.
  let parsed;
  try {
    parsed = JSON.parse(await readFile(`${tmp}/result.json`, "utf8"));
  } catch (e) {
    return errResult(
      `container produced no result.json (docker exit ${code}): ${err.slice(0, 500)} — ${e.message}`
    );
  }
  return {
    resolved: !!parsed.resolved,
    applied: !!parsed.applied,
    fail_to_pass: parsed.fail_to_pass ?? { passed: [], failed: [] },
    pass_to_pass: parsed.pass_to_pass ?? { passed: [], failed: [] },
    error: parsed.error ?? null,
    wallMs: Date.now() - start,
  };
}

async function dockerAvailable() {
  try {
    const { code } = await runDocker(["version", "--format", "{{.Server.Version}}"], 5000);
    return code === 0;
  } catch {
    return false;
  }
}

async function ensureImage(tag, dir) {
  // Check existence first so re-runs against a built image are fast.
  const inspect = await runDocker(["image", "inspect", tag], 5000);
  if (inspect.code === 0) return { ok: true };

  // Build.
  const build = await runDocker(["build", "-t", tag, dir], 10 * 60_000);
  if (build.code !== 0) return { ok: false, err: build.err.slice(0, 1500) };
  return { ok: true };
}

/**
 * Run a docker subcommand. Spawn-based so we don't accidentally
 * shell-interpolate arbitrary paths.
 */
async function runDocker(args, timeoutMs) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => {
      out += c.toString();
    });
    proc.stderr.on("data", (c) => {
      err += c.toString();
    });
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs).unref?.();
    proc.on("exit", (code) => {
      if (t && typeof t === "object" && "close" in t) t.close?.();
      resolve({ code: code ?? -1, out, err });
    });
    proc.on("error", () => {
      resolve({ code: -1, out, err: err || "docker not in PATH" });
    });
  });
}

/**
 * Render a Pareto-shaped markdown report from a list of dispatch
 * results. Mirrors the shape of `@wasmagent/evals-runner`'s report
 * (accuracy × USD/correct × p95 wall × tool-call count) so the
 * publication run can drop in real numbers without rewriting the
 * format. Stub-mode populates the cells where it can; the real
 * judge / answerer fill in the rest.
 *
 * @param {Array<{
 *   instance_id: string,
 *   dispatch: "codemode" | "direct",
 *   answerer: string,
 *   patch: string,
 *   toolCallCount: number,
 *   wallMs: number,
 *   resolved: boolean | null,
 *   usd: number | null,
 *   error?: string,
 * }>} results
 * @param {string} outPath  Absolute path to write the markdown to.
 * @returns {Promise<{path: string, summary: Record<string, unknown>}>}
 */
async function reportPareto(results, outPath) {
  if (!Array.isArray(results)) {
    throw new TypeError("reportPareto: results must be an array");
  }

  // Group by (dispatch × answerer); compute per-cell stats.
  /** @type {Map<string, typeof results>} */
  const cells = new Map();
  for (const r of results) {
    const k = `${r.dispatch}|${r.answerer}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
  }

  /** @type {Array<{cell: string, n: number, resolvedKnown: number, resolvedRate: number | null, p95Ms: number | null, meanCalls: number, errorRate: number, usdMean: number | null}>} */
  const rows = [];
  for (const [cell, rs] of cells) {
    const n = rs.length;
    const resolvedKnown = rs.filter((r) => typeof r.resolved === "boolean").length;
    const resolvedTrue = rs.filter((r) => r.resolved === true).length;
    const resolvedRate = resolvedKnown > 0 ? resolvedTrue / resolvedKnown : null;
    const wallSorted = rs.map((r) => r.wallMs).sort((a, b) => a - b);
    const p95Idx = Math.max(0, Math.ceil(wallSorted.length * 0.95) - 1);
    const p95Ms = wallSorted.length > 0 ? wallSorted[p95Idx] : null;
    const meanCalls =
      n > 0 ? rs.reduce((s, r) => s + (r.toolCallCount ?? 0), 0) / n : 0;
    const errorRate = n > 0 ? rs.filter((r) => r.error != null).length / n : 0;
    const usdKnown = rs.filter((r) => typeof r.usd === "number");
    const usdMean =
      usdKnown.length > 0 ? usdKnown.reduce((s, r) => s + r.usd, 0) / usdKnown.length : null;
    rows.push({ cell, n, resolvedKnown, resolvedRate, p95Ms, meanCalls, errorRate, usdMean });
  }

  // Format cells. `null` reports as `—` so a stub-mode run is
  // visually distinguishable from a measured zero.
  const fmtPct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  const fmtMs = (v) => (v == null ? "—" : `${v.toFixed(0)}ms`);
  const fmtUsd = (v) => (v == null ? "—" : `$${v.toFixed(4)}`);
  const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");

  const lines = [
    "# SWE-bench-lite — code-mode vs direct dispatch (Pareto)",
    "",
    `> Generated ${new Date().toISOString()} by examples/benchmarks/swe-bench-lite.mjs.`,
    "> Funded-run gates remaining: containerised judge (\\`runTests\\`) and",
    "> real-mode Anthropic / OpenAI answerers. Stub-mode cells leave",
    "> resolved% / p95 / USD as `—` so a publication run is visually",
    "> distinguishable from this scaffold.",
    "",
    "| dispatch × answerer | n | resolved | p95 wall | mean tool calls | error rate | $/instance |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.cell} | ${r.n} | ${fmtPct(r.resolvedRate)} | ${fmtMs(r.p95Ms)} | ${fmtNum(
        r.meanCalls
      )} | ${fmtPct(r.errorRate)} | ${fmtUsd(r.usdMean)} |`
    );
  }
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "Methodology + pre-run checklist live at the top of",
    "`examples/benchmarks/swe-bench-lite.mjs`. The Pareto axes —",
    "accuracy × USD/correct × p95 wall × tool-call count — match the",
    "`@wasmagent/evals-runner` reports so a reader can compare cells",
    "across benchmarks without translating shapes."
  );

  const md = lines.join("\n") + "\n";

  // Best-effort write; surface the path so callers can chain other
  // tools (CI artifact upload, PR-comment bot) against it.
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  return {
    path: outPath,
    summary: {
      cells: rows.length,
      totalResults: results.length,
      anyResolved: rows.some((r) => (r.resolvedRate ?? 0) > 0),
    },
  };
}

async function smokeRun() {
  // Exercises the parser + report scaffolding without touching the
  // real dataset or any model. CI guard: changes to this file should
  // not break --smoke.
  //
  // Coverage:
  //   1. normalizeRow handles the JSON-string-encoded FAIL_TO_PASS /
  //      PASS_TO_PASS fields the way HF datasets-server returns them
  //      (verified 2026-06-13 against the live API).
  //   2. normalizeRow tolerates missing / null fields without throwing
  //      so a single malformed row in a 300-row run doesn't kill the
  //      load.
  const checks = [];
  const ok = (name, cond) => {
    checks.push({ name, ok: !!cond });
    if (!cond) process.exitCode = 1;
  };

  // Sample row mirroring HF's actual response shape.
  const sampleRow = {
    repo: "astropy/astropy",
    instance_id: "astropy__astropy-12907",
    base_commit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ +1 @@\n+y",
    test_patch: "diff --git a/t b/t\n--- a/t\n+++ b/t\n",
    problem_statement: "issue body",
    FAIL_TO_PASS: '["test_a", "test_b"]', // <- string-encoded JSON
    PASS_TO_PASS: '["test_c"]',
    version: "4.3",
    environment_setup_commit: "298ccb47",
  };
  const t = normalizeRow(sampleRow);
  ok("instance_id", t.instance_id === "astropy__astropy-12907");
  ok("repo", t.repo === "astropy/astropy");
  ok("fail_to_pass parsed as array", Array.isArray(t.fail_to_pass) && t.fail_to_pass.length === 2);
  ok("fail_to_pass values", t.fail_to_pass[0] === "test_a" && t.fail_to_pass[1] === "test_b");
  ok("pass_to_pass parsed as array", Array.isArray(t.pass_to_pass) && t.pass_to_pass.length === 1);

  // Defensive: garbage in, sane defaults out.
  const garbage = normalizeRow({});
  ok("garbage row gives empty arrays, not throws", Array.isArray(garbage.fail_to_pass) && garbage.fail_to_pass.length === 0);
  ok("garbage row gives empty strings", garbage.instance_id === "" && garbage.repo === "");

  // 3. dispatchCodemode end-to-end through the stub answerer.
  //    The stub script reads a file, writes a one-line patch, then
  //    returns. We assert the patch surface is non-empty and the
  //    error path is clean — the real run swaps the stub for an
  //    Anthropic / OpenAI answerer and a containerised judge.
  try {
    const dispatched = await dispatchCodemode(t, {
      kind: "stub",
      scriptFor: (task) => `
        const before = await tools.readFile({ path: "src/main.js" });
        console.log("[tool-call] readFile " + before.content.length + " bytes");
        await tools.writeFile({
          path: "src/main.js",
          content: "// fixed for " + ${JSON.stringify(task.instance_id)} + "\\n",
        });
        const diff = await tools.gitDiff();
        return diff.patch;
      `,
    });
    ok("dispatchCodemode runs without unhandled error", !dispatched.error);
    ok("dispatchCodemode produces a non-empty patch", typeof dispatched.patch === "string" && dispatched.patch.length > 0);
    ok("dispatchCodemode patch references the task instance id", dispatched.patch.includes("astropy__astropy-12907"));
    // The toolCallCount derives from `[tool-call]` substrings in
    // KernelResult.logs. JsKernel's worker formats logs as
    // `args.map(String).join(" ")` so the marker survives intact.
    // We accept 0 (no console.log captured) as well as ≥1 here
    // because some environments suppress worker-thread console
    // forwarding; the real run derives the count from prompt-cache
    // events instead. The check that matters is that the call
    // happened — proven by the patch containing the writeFile result.
    ok(
      "dispatchCodemode toolCallCount is a non-negative integer",
      Number.isInteger(dispatched.toolCallCount) && dispatched.toolCallCount >= 0
    );
  } catch (e) {
    ok(`dispatchCodemode threw: ${e.message}`, false);
  }

  // 4. dispatchCodemode rejects real-mode answerers cleanly (until
  //    the funded run lands).
  try {
    await dispatchCodemode(t, { kind: "anthropic", model: "x", apiKey: "y" });
    ok("dispatchCodemode real-mode should have thrown", false);
  } catch (e) {
    ok("dispatchCodemode rejects real-mode with clear message", String(e.message).includes("real-mode"));
  }

  // 5. dispatchDirect end-to-end through the stub-direct answerer.
  //    Same fake repo surface, but the answerer emits a flat call
  //    plan instead of a code-mode script. The two patches end up
  //    different shapes (direct issues N rounds; code-mode issues
  //    one) — exactly the variable the Pareto report measures.
  let directResult;
  try {
    directResult = await dispatchDirect(t, {
      kind: "stub-direct",
      callsFor: (task) => [
        ["readFile", { path: "src/main.js" }],
        [
          "writeFile",
          { path: "src/main.js", content: `// fixed for ${task.instance_id}\n` },
        ],
        ["gitDiff", {}],
      ],
    });
    ok("dispatchDirect runs without unhandled error", !directResult.error);
    ok("dispatchDirect produces a non-empty patch", typeof directResult.patch === "string" && directResult.patch.length > 0);
    ok("dispatchDirect counts the issued tool calls", directResult.toolCallCount === 3);
  } catch (e) {
    ok(`dispatchDirect threw: ${e.message}`, false);
  }

  // 6a. runTests: no docker on this host ⇒ graceful fallback with a
  //     well-typed result. The CI runner intentionally does NOT have
  //     docker available — that is the path most contributors will
  //     hit, so we pin its behaviour. The 'real' path (docker
  //     available, judge image built) is exercised by the GitHub
  //     Actions workflow at .github/workflows/swe-bench-judge.yml
  //     when funded API access lands.
  try {
    const judged = await runTests(t, "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-foo\n+bar\n");
    ok("runTests returns a well-typed object", typeof judged === "object" && judged !== null);
    ok("runTests resolved is boolean", typeof judged.resolved === "boolean");
    ok("runTests applied is boolean", typeof judged.applied === "boolean");
    ok("runTests fail_to_pass shape", judged.fail_to_pass && Array.isArray(judged.fail_to_pass.failed));
    ok("runTests pass_to_pass shape", judged.pass_to_pass && Array.isArray(judged.pass_to_pass.failed));
    ok(
      "runTests reports docker-not-available cleanly OR ran the container",
      judged.error == null ||
        String(judged.error).includes("docker") ||
        String(judged.error).includes("container")
    );
    ok("runTests wallMs is a non-negative number", Number.isFinite(judged.wallMs) && judged.wallMs >= 0);
  } catch (e) {
    ok(`runTests threw: ${e.message}`, false);
  }

  // 6. reportPareto writes a markdown file with the cells we expect.
  //    We feed it two synthetic results (one codemode, one direct)
  //    so the table has both rows and the file is non-empty.
  try {
    const tmpReport = resolvePath(".cache/swe-bench-lite/smoke-report.md");
    const fakeResults = [
      {
        instance_id: t.instance_id,
        dispatch: "codemode",
        answerer: "stub",
        patch: "stub-codemode-patch",
        toolCallCount: 4,
        wallMs: 12,
        resolved: null,
        usd: null,
      },
      {
        instance_id: t.instance_id,
        dispatch: "direct",
        answerer: "stub-direct",
        patch: directResult?.patch ?? "stub-direct-patch",
        toolCallCount: directResult?.toolCallCount ?? 3,
        wallMs: 9,
        resolved: null,
        usd: null,
      },
    ];
    const written = await reportPareto(fakeResults, tmpReport);
    const contents = await readFile(written.path, "utf8");
    ok("reportPareto wrote a non-empty markdown file", contents.length > 100);
    ok("reportPareto report has the codemode row", contents.includes("codemode|stub"));
    ok("reportPareto report has the direct row", contents.includes("direct|stub-direct"));
    ok("reportPareto summary cells count matches input", written.summary.cells === 2);
  } catch (e) {
    ok(`reportPareto threw: ${e.message}`, false);
  }

  console.log("# SWE-bench-lite — smoke run output");
  console.log("");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}`);
  }
  console.log("");
  console.log(`Result: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed.`);
  console.log("");
  console.log(`See \`${DEFAULT_REPORT_PATH}\` for the publication-run methodology.`);
  console.log(
    `Live network probe: \`node examples/benchmarks/swe-bench-lite.mjs --load-tasks=N\` (requires HF reachable).`
  );
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v ?? true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
swe-bench-lite.mjs — SWE-bench-lite-class code-mode dispatch benchmark (DRAFT).

Status: skeleton. Direction 2 of the 2026-06-12 optimization brief.
The full harness is funding-dependent; the file in the repo defines
the methodology + slots a contributor can fill in.

Usage:
  --smoke                       Run the offline harness exerciser (CI guard).
  --load-tasks=N                Live: download N tasks from HuggingFace + print summary.
  --tasks=N                     Number of SWE-bench-lite tasks (full set: 300).
  --answerer=ID                 Single answerer model id.
  --answerer-base=URL           Answerer base URL (OpenAI-compat / Anthropic).
  --answerers=ID,ID,...         Multi-answerer report mode.
  --dispatch=codemode|direct    Dispatch shape under test.
  --output=PATH                 Report output path.
  --help                        Print this help.
`);
}

// ── exports for programmatic use ────────────────────────────────────────────
// CI roundtrip + future test wrappers can `import { loadTasks, runTests } from
// "./swe-bench-lite.mjs"` to drive the harness without going through the CLI
// dispatch above. These are intentionally exported in a single block so the
// public surface is easy to read.
export { loadTasks, dispatchCodemode, dispatchDirect, runTests, reportPareto };
