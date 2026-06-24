#!/usr/bin/env bun
/**
 * IFEval 50-sample × 3-baseline sweep.
 *
 * Run with:
 *   bun packages/compliance/benchmarks/ifeval/run.ts \
 *     [--samples=samples.jsonl] \
 *     [--model=qwen2.5-1.5b] \
 *     [--out=results] \
 *     [--limit=50] \
 *     [--modes=direct,prompt_retry,full_pcl] \
 *     [--max-retries=3]
 *
 * Outputs:
 *   results/runs.jsonl      — one ComplianceEvalRecord per line
 *   results/summary.md      — Markdown table of per-mode aggregates
 *   results/summary.json    — same aggregates in machine-readable form
 *
 * The script loads the LocalModel ONCE and reuses it across all 150
 * runs. Model load is the heaviest cost (~1s for Qwen2.5-1.5B on
 * this machine); sharing it cuts ~50s off the wall-clock for the
 * 50-sample sweep.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicVerifier, VerificationPipeline, type WorkspaceReader } from "@wasmagent/core";
import type { Model } from "@wasmagent/core/models";
import { LocalModel } from "@wasmagent/model-local";
import { RepairPlanner, type WorkspaceWriter } from "../../src/repair/RepairPlanner.js";
import {
  type ComplianceEvalRecord,
  ComplianceRun,
  type RunMode,
} from "../../src/runner/ComplianceRun.js";
import { ModelRepairLLM } from "../../src/runner/ModelRepairLLM.js";
import { ComplianceVerifier } from "../../src/verifier/ComplianceVerifier.js";
import { IFEvalVerifier } from "../../src/verifier/ifeval/IFEvalVerifier.js";
import { type LoadedTask, loadIFEvalSamples } from "./load.js";

// ── CLI args ────────────────────────────────────────────────────────────────

interface Args {
  samples: string;
  model: string;
  out: string;
  limit: number;
  modes: RunMode[];
  maxRetries: number;
  /**
   * Seed for the initial generation. Default 42. Pinning the seed
   * makes the sweep reproducible across runs — without it the model's
   * stochastic sampling produces different first-shot artifacts even
   * with identical (temperature, max_tokens, prompt) inputs, and the
   * sweep-vs-sweep deltas reflect sampling noise instead of code
   * changes. Confirmed empirically on the 2026-06-24 P1 run.
   */
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    samples: join(import.meta.dir, "samples.jsonl"),
    model: "qwen2.5-1.5b",
    out: join(import.meta.dir, "results"),
    limit: 50,
    modes: ["direct", "prompt_retry", "full_pcl"],
    maxRetries: 3,
    seed: 42,
  };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2] ?? "";
    switch (key) {
      case "samples":
        args.samples = val;
        break;
      case "model":
        args.model = val;
        break;
      case "out":
        args.out = val;
        break;
      case "limit":
        args.limit = Number(val);
        break;
      case "modes":
        args.modes = val.split(",") as RunMode[];
        break;
      case "max-retries":
        args.maxRetries = Number(val);
        break;
      case "seed":
        args.seed = Number(val);
        break;
    }
  }
  return args;
}

// ── Per-run scaffolding ─────────────────────────────────────────────────────

function diskWorkspace(rootDir: string) {
  mkdirSync(rootDir, { recursive: true });
  const reader: WorkspaceReader = {
    async readFile(path) {
      return readFileSync(join(rootDir, path), "utf8");
    },
    async fileExists(path) {
      return existsSync(join(rootDir, path));
    },
    async fileSize(path) {
      return readFileSync(join(rootDir, path)).byteLength;
    },
  };
  const writer: WorkspaceWriter = {
    async writeFile(path, body) {
      writeFileSync(join(rootDir, path), body, "utf8");
    },
  };
  return { reader, writer };
}

async function runOne(
  mode: RunMode,
  task: LoadedTask,
  model: Model,
  modelId: string,
  maxRetries: number,
  seed: number
): Promise<ComplianceEvalRecord> {
  const rootDir = mkdtempSync(join(tmpdir(), `compliance-sweep-${mode}-`));
  const ws = diskWorkspace(rootDir);
  const pipeline = new VerificationPipeline({
    ws: ws.reader,
    verifiers: [new IFEvalVerifier(), new DeterministicVerifier()],
  });
  const verifier = new ComplianceVerifier({ pipeline });
  const runOpts = {
    spec: task.spec,
    prompt: task.sample.prompt,
    artifact_path: task.responsePath,
    model_id: modelId,
    mode,
    model,
    verifier,
    writer: ws.writer,
    max_tokens: 512,
    temperature: 0.2,
    seed,
    max_retries: maxRetries,
  };
  try {
    if (mode === "full_pcl") {
      const llm = new ModelRepairLLM({ model });
      const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
      return await new ComplianceRun({ ...runOpts, planner }).execute();
    }
    return await new ComplianceRun(runOpts).execute();
  } finally {
    // Clean up the per-run scratch dir; we keep results in JSONL.
    try {
      rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

interface PerModeStats {
  mode: RunMode;
  n: number;
  pass: number;
  pass_rate: number;
  /** Records with `error` set — excluded from pass/fail accounting. */
  errors: number;
  /** Errors grouped by their error.kind for quick triage. */
  errors_by_kind: Record<string, number>;
  avg_repair_rounds: number;
  avg_prompt_tokens: number;
  avg_generation_tokens: number;
  avg_repair_tokens: number;
  avg_total_tokens: number;
  avg_latency_ms: number;
  failure_by_constraint: Record<string, number>;
}

function aggregate(mode: RunMode, records: ComplianceEvalRecord[]): PerModeStats {
  // Split infrastructural errors from verifier failures. Errors do
  // NOT count toward pass_rate — they invalidate the experiment for
  // that sample. Surfacing them as a separate column keeps the rate
  // numbers honest.
  const errored = records.filter((r) => r.error !== undefined);
  const valid = records.filter((r) => r.error === undefined);
  const n = valid.length;
  let pass = 0;
  let rounds = 0;
  let pT = 0;
  let gT = 0;
  let rT = 0;
  let lat = 0;
  const failByConstraint: Record<string, number> = {};
  for (const r of valid) {
    if (r.final_pass) pass++;
    rounds += r.repair_rounds;
    pT += r.token_cost.prompt ?? 0;
    gT += r.token_cost.generation ?? 0;
    rT += r.token_cost.repair ?? 0;
    lat += r.latency_ms;
    if (!r.final_pass) {
      // Group by verify_method to spot which classes hurt the most.
      // r.violations is the initial set; for final-fail tallying we
      // want the *unresolved* set. The planner records that under
      // remaining; but for prompt_retry/direct we only have
      // r.violations. Use violations as the proxy — both are
      // pre-repair counts and useful for the failure taxonomy.
      for (const v of r.violations) {
        // Extract the upstream IFEval instruction_id from the
        // constraint_id format: "<sample_key>:<i>:<instruction_id>".
        const parts = v.constraint_id.split(":");
        const iid = parts.slice(2).join(":") || v.constraint_id;
        failByConstraint[iid] = (failByConstraint[iid] ?? 0) + 1;
      }
    }
  }
  const errorsByKind: Record<string, number> = {};
  for (const r of errored) {
    const k = r.error?.kind ?? "unknown";
    errorsByKind[k] = (errorsByKind[k] ?? 0) + 1;
  }
  return {
    mode,
    n,
    pass,
    pass_rate: n > 0 ? pass / n : 0,
    errors: errored.length,
    errors_by_kind: errorsByKind,
    avg_repair_rounds: n > 0 ? rounds / n : 0,
    avg_prompt_tokens: n > 0 ? pT / n : 0,
    avg_generation_tokens: n > 0 ? gT / n : 0,
    avg_repair_tokens: n > 0 ? rT / n : 0,
    avg_total_tokens: n > 0 ? (pT + gT + rT) / n : 0,
    avg_latency_ms: n > 0 ? lat / n : 0,
    failure_by_constraint: failByConstraint,
  };
}

function fmtNum(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "n/a";
  return x.toFixed(digits);
}

function buildSummaryMarkdown(args: Args, stats: PerModeStats[], wallClockMs: number): string {
  const lines: string[] = [];
  lines.push("# IFEval Compliance Sweep — Results");
  lines.push("");
  lines.push(`- Model: \`${args.model}\``);
  lines.push(`- Samples: ${args.limit} (from \`${args.samples}\`)`);
  lines.push(`- Modes: ${args.modes.join(", ")}`);
  lines.push(`- Wall-clock: ${(wallClockMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## Per-mode aggregates");
  lines.push("");
  lines.push(
    "| mode | n | pass | pass_rate | errors | avg_rounds | avg_prompt_tok | avg_gen_tok | avg_repair_tok | avg_total_tok | avg_latency_ms |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of stats) {
    const errCol =
      s.errors === 0
        ? "0"
        : `${s.errors} (${Object.entries(s.errors_by_kind)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")})`;
    lines.push(
      `| ${s.mode} | ${s.n} | ${s.pass} | ${fmtNum(s.pass_rate * 100, 1)}% | ${errCol} | ${fmtNum(s.avg_repair_rounds, 2)} | ${fmtNum(s.avg_prompt_tokens, 0)} | ${fmtNum(s.avg_generation_tokens, 0)} | ${fmtNum(s.avg_repair_tokens, 0)} | ${fmtNum(s.avg_total_tokens, 0)} | ${fmtNum(s.avg_latency_ms, 0)} |`
    );
  }
  lines.push("");
  lines.push(
    "> `n` and rate columns exclude runs whose `error` field is set; those are counted under `errors` and broken down by kind. This keeps infrastructure failures from contaminating compliance metrics."
  );
  lines.push("");
  lines.push("## Failure taxonomy (initial violations among failed runs)");
  lines.push("");
  for (const s of stats) {
    const entries = Object.entries(s.failure_by_constraint).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      lines.push(`### ${s.mode}: no failures`);
      lines.push("");
      continue;
    }
    lines.push(`### ${s.mode}`);
    lines.push("");
    lines.push("| instruction_id | count |");
    lines.push("|---|---|");
    for (const [iid, n] of entries) lines.push(`| \`${iid}\` | ${n} |`);
    lines.push("");
  }
  lines.push("## How to interpret");
  lines.push("");
  lines.push(
    "- `pass_rate` is the fraction of samples whose hard constraints ALL passed at end of run."
  );
  lines.push(
    "- `avg_repair_tok` only counts tokens spent on repair (prompt_retry retries, full_pcl LLM rounds). Deterministic patches contribute 0."
  );
  lines.push(
    "- The PCL paper claim is `full_pcl` should match or beat `prompt_retry` pass-rate at lower `avg_total_tok`."
  );
  return lines.join("\n") + "\n";
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  mkdirSync(args.out, { recursive: true });
  const runsPath = join(args.out, "runs.jsonl");
  const summaryMdPath = join(args.out, "summary.md");
  const summaryJsonPath = join(args.out, "summary.json");
  const lockPath = join(args.out, ".sweep.lock");

  // Single-writer guard. Two concurrent sweeps against the same
  // results directory will race on runs.jsonl (append-without-lock)
  // AND on the GGUF model file (node-llama-cpp deadlocks on sequence
  // allocation under concurrent access — surfaced 2026-06-24). We
  // create a lock file containing our pid; if a fresh lock exists,
  // refuse to start. Stale locks (process dead) are detected by
  // signalling pid 0 and replaced.
  if (existsSync(lockPath)) {
    const owner = Number((readFileSync(lockPath, "utf8") || "0").trim());
    let alive = false;
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      console.error(
        `error: another sweep is running on ${args.out} (pid ${owner}, lock: ${lockPath}).`
      );
      console.error("       Wait for it to finish, or kill that process and remove the lock.");
      process.exit(1);
    }
    console.error(`# clearing stale lock from dead pid ${owner}`);
  }
  writeFileSync(lockPath, `${process.pid}\n`);
  const releaseLock = () => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // best-effort
    }
  };
  // Release lock on every exit path — normal end, SIGINT, SIGTERM,
  // uncaught error. Without this a Ctrl-C leaves a stale lock that
  // confuses the next sweep.
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });

  // Resume support: load already-completed (mode, task_id) pairs so a
  // restart skips them. Helpful because llama.cpp can OOM / segfault
  // on long generations and we don't want to lose hours of work.
  const done = new Set<string>();
  if (existsSync(runsPath)) {
    for (const line of readFileSync(runsPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed) as ComplianceEvalRecord;
        done.add(`${r.mode}|${r.task_id}`);
      } catch {
        /* skip malformed line */
      }
    }
    if (done.size > 0) {
      console.error(`# resuming — ${done.size} runs already in ${runsPath}`);
    }
  }

  console.error(
    `# IFEval sweep — model=${args.model}  samples=${args.limit}  modes=${args.modes.join("+")}`
  );
  console.error(`#   out=${args.out}`);

  const tasks = loadIFEvalSamples(args.samples).slice(0, args.limit);
  if (tasks.length === 0) {
    console.error("error: no samples loaded");
    process.exit(1);
  }

  // Load model once.
  const model = new LocalModel({ source: { model: args.model } });
  const t_load_0 = performance.now();
  await model.load();
  console.error(`# model loaded in ${Math.round(performance.now() - t_load_0)}ms`);

  const t_sweep_0 = performance.now();
  const byMode = new Map<RunMode, ComplianceEvalRecord[]>();
  for (const m of args.modes) byMode.set(m, []);
  // Seed byMode with already-completed runs so the summary covers
  // everything once we reach the end.
  if (done.size > 0) {
    for (const line of readFileSync(runsPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed) as ComplianceEvalRecord;
        const bucket = byMode.get(r.mode);
        if (bucket) bucket.push(r);
      } catch {
        /* skip */
      }
    }
  }

  let runIdx = 0;
  const totalRuns = tasks.length * args.modes.length;
  for (const task of tasks) {
    for (const mode of args.modes) {
      runIdx++;
      const key = `${mode}|${task.spec.id}`;
      if (done.has(key)) {
        console.error(
          `[${runIdx}/${totalRuns}] ${mode.padEnd(13)} key=${task.sample.key.toString().padEnd(5)} SKIP (already done)`
        );
        continue;
      }
      const t0 = performance.now();
      let record: ComplianceEvalRecord;
      try {
        record = await runOne(mode, task, model, args.model, args.maxRetries, args.seed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[${runIdx}/${totalRuns}] ${mode.padEnd(13)} key=${task.sample.key.toString().padEnd(5)} ERROR: ${msg}`
        );
        continue;
      }
      const dt = Math.round(performance.now() - t0);
      const bucket = byMode.get(mode);
      if (bucket) bucket.push(record);
      appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
      const totalTok =
        (record.token_cost.prompt ?? 0) +
        (record.token_cost.generation ?? 0) +
        (record.token_cost.repair ?? 0);
      // Highlight infrastructure errors in the live log so a user
      // watching the sweep notices broken runs immediately, not after
      // grepping the JSONL at the end.
      const status = record.error
        ? `ERR(${record.error.kind}@${record.error.stage})`
        : `pass=${record.final_pass ? "Y" : "N"}  rounds=${record.repair_rounds}`;
      console.error(
        `[${runIdx}/${totalRuns}] ${mode.padEnd(13)} key=${task.sample.key.toString().padEnd(5)} ${status}  tok=${totalTok.toString().padStart(4)}  ms=${dt}`
      );
    }
  }
  const wallClockMs = Math.round(performance.now() - t_sweep_0);

  // Aggregate + write summary.
  const stats: PerModeStats[] = [];
  for (const mode of args.modes) stats.push(aggregate(mode, byMode.get(mode) ?? []));
  writeFileSync(summaryJsonPath, JSON.stringify(stats, null, 2));
  writeFileSync(summaryMdPath, buildSummaryMarkdown(args, stats, wallClockMs));

  console.error("");
  console.error(`# sweep complete in ${(wallClockMs / 1000).toFixed(1)}s`);
  console.error(`# wrote ${runsPath}`);
  console.error(`# wrote ${summaryMdPath}`);
  console.error(`# wrote ${summaryJsonPath}`);
  console.error("");
  // Echo the markdown to stdout so callers can pipe it.
  process.stdout.write(readFileSync(summaryMdPath, "utf8"));
}

await main();
