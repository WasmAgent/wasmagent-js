#!/usr/bin/env bun
/**
 * Multi-seed comparison — aggregate N seeded sweeps into a single
 * mean/stddev report.
 *
 * Why three seeds, not one: with `temperature=0.2` and an unfixed
 * model, the same (prompt, model, config) tuple produces different
 * artifacts every run (47/50 different across two trial runs on
 * 2026-06-24). One seed gives a point estimate; three give a
 * minimum-credible mean and let one outlier be obvious.
 *
 * Usage:
 *   bun packages/compliance/benchmarks/ifeval/compare-seeds.ts \
 *     packages/compliance/benchmarks/ifeval/results \
 *     packages/compliance/benchmarks/ifeval/results-seed43 \
 *     packages/compliance/benchmarks/ifeval/results-seed44 \
 *     --out=packages/compliance/benchmarks/ifeval/results-multi-seed
 *
 * Each input directory must contain `runs.jsonl` in
 * ComplianceEvalRecord shape.
 *
 * Output:
 *   - multi-seed-summary.json  — typed aggregates (mean, stddev, per-seed)
 *   - multi-seed-summary.md    — table + per-sample agreement analysis
 *
 * No new statistical machinery — just mean, stddev, and per-sample
 * agreement counts. Anything more rigorous (bootstrap CI, paired
 * t-test) belongs in Phase 1 once we have N=10+ seeds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ComplianceEvalRecord, RunMode } from "../../src/runner/ComplianceRun.js";

interface SeedRun {
  /** Directory name (used as label). */
  label: string;
  dir: string;
  records: ComplianceEvalRecord[];
}

function loadSeedRun(dir: string): SeedRun {
  const path = join(dir, "runs.jsonl");
  if (!existsSync(path)) {
    throw new Error(`no runs.jsonl in ${dir}`);
  }
  const raw = readFileSync(path, "utf8");
  const records: ComplianceEvalRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as ComplianceEvalRecord);
  }
  return { label: basename(dir), dir, records };
}

// ── Per-seed aggregation ────────────────────────────────────────────────────

interface PerSeedStats {
  label: string;
  mode: RunMode;
  /** Count of records with `error` set — excluded from valid below. */
  errors: number;
  /** Valid runs (no infrastructure error). */
  n: number;
  pass: number;
  pass_rate: number;
  avg_repair_rounds: number;
  avg_total_tokens: number;
  avg_latency_ms: number;
}

function perSeedStats(label: string, mode: RunMode, records: ComplianceEvalRecord[]): PerSeedStats {
  const mine = records.filter((r) => r.mode === mode);
  const errored = mine.filter((r) => r.error !== undefined);
  const valid = mine.filter((r) => r.error === undefined);
  const n = valid.length;
  let pass = 0,
    rounds = 0,
    tok = 0,
    lat = 0;
  for (const r of valid) {
    if (r.final_pass) pass++;
    rounds += r.repair_rounds;
    tok += (r.token_cost.prompt ?? 0) + (r.token_cost.generation ?? 0) + (r.token_cost.repair ?? 0);
    lat += r.latency_ms;
  }
  return {
    label,
    mode,
    errors: errored.length,
    n,
    pass,
    pass_rate: n > 0 ? pass / n : 0,
    avg_repair_rounds: n > 0 ? rounds / n : 0,
    avg_total_tokens: n > 0 ? tok / n : 0,
    avg_latency_ms: n > 0 ? lat / n : 0,
  };
}

// ── Cross-seed aggregation ──────────────────────────────────────────────────

interface CrossSeedStats {
  mode: RunMode;
  seeds: PerSeedStats[];
  pass_rate_mean: number;
  pass_rate_stddev: number;
  avg_total_tokens_mean: number;
  avg_total_tokens_stddev: number;
  avg_latency_ms_mean: number;
  avg_latency_ms_stddev: number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  // n-1 (Bessel) since seeds are samples from the full seed-space.
  return Math.sqrt(s / (xs.length - 1));
}

function aggregateAcrossSeeds(mode: RunMode, seedRuns: SeedRun[]): CrossSeedStats {
  const seeds = seedRuns.map((s) => perSeedStats(s.label, mode, s.records));
  const rates = seeds.map((s) => s.pass_rate);
  const toks = seeds.map((s) => s.avg_total_tokens);
  const lats = seeds.map((s) => s.avg_latency_ms);
  return {
    mode,
    seeds,
    pass_rate_mean: mean(rates),
    pass_rate_stddev: stddev(rates),
    avg_total_tokens_mean: mean(toks),
    avg_total_tokens_stddev: stddev(toks),
    avg_latency_ms_mean: mean(lats),
    avg_latency_ms_stddev: stddev(lats),
  };
}

// ── Per-sample agreement ────────────────────────────────────────────────────
//
// "Does full_pcl beat prompt_retry on every seed?" If yes, the +6pp
// gap isn't a lucky single trajectory.

interface PairwiseAgreement {
  mode_a: RunMode;
  mode_b: RunMode;
  /** Number of (seed, sample) pairs where mode_a passed and mode_b failed. */
  a_only: number;
  /** mode_b passed, mode_a failed. */
  b_only: number;
  /** Both passed. */
  both: number;
  /** Both failed. */
  neither: number;
  /** Total pairs compared (= n_seeds × n_samples). */
  total: number;
}

function pairwiseAgreement(modeA: RunMode, modeB: RunMode, seedRuns: SeedRun[]): PairwiseAgreement {
  let a_only = 0,
    b_only = 0,
    both = 0,
    neither = 0,
    total = 0;
  for (const seed of seedRuns) {
    const byKey = new Map<string, { a?: boolean; b?: boolean }>();
    for (const r of seed.records) {
      if (r.error) continue;
      if (r.mode !== modeA && r.mode !== modeB) continue;
      const k = r.task_id;
      const slot = byKey.get(k) ?? {};
      if (r.mode === modeA) slot.a = r.final_pass;
      else slot.b = r.final_pass;
      byKey.set(k, slot);
    }
    for (const [, s] of byKey) {
      if (s.a === undefined || s.b === undefined) continue;
      total++;
      if (s.a && !s.b) a_only++;
      else if (!s.a && s.b) b_only++;
      else if (s.a && s.b) both++;
      else neither++;
    }
  }
  return { mode_a: modeA, mode_b: modeB, a_only, b_only, both, neither, total };
}

// ── Markdown report ─────────────────────────────────────────────────────────

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

function buildMarkdown(
  seedRuns: SeedRun[],
  crossStats: CrossSeedStats[],
  agreements: PairwiseAgreement[]
): string {
  const lines: string[] = [];
  lines.push("# IFEval Multi-Seed Sweep — Aggregate");
  lines.push("");
  lines.push(`- Seeds: ${seedRuns.length}`);
  lines.push(`- Per-seed source directories:`);
  for (const s of seedRuns) lines.push(`  - \`${s.label}\` (${s.records.length} records)`);
  lines.push("");
  lines.push("## Mean ± stddev across seeds");
  lines.push("");
  lines.push("| mode | pass_rate | avg_total_tokens | avg_latency_ms |");
  lines.push("|---|---|---|---|");
  for (const cs of crossStats) {
    lines.push(
      `| ${cs.mode} | ${fmt(cs.pass_rate_mean * 100, 1)}% ± ${fmt(cs.pass_rate_stddev * 100, 1)} | ${fmt(cs.avg_total_tokens_mean, 0)} ± ${fmt(cs.avg_total_tokens_stddev, 0)} | ${fmt(cs.avg_latency_ms_mean, 0)} ± ${fmt(cs.avg_latency_ms_stddev, 0)} |`
    );
  }
  lines.push("");
  lines.push(
    "> Stddev uses n-1 (Bessel) — interpret as sample stddev across seeds. With only 3 seeds the stddev is a coarse estimate, but it sets a floor on how big a real effect must be to be credible."
  );
  lines.push("");

  lines.push("## Per-seed pass rates");
  lines.push("");
  // Build a header row of seed labels
  const labels = seedRuns.map((s) => s.label);
  lines.push(`| mode | ${labels.join(" | ")} |`);
  lines.push(`|---|${labels.map(() => "---").join("|")}|`);
  for (const cs of crossStats) {
    const cells = cs.seeds.map((s) => `${fmt(s.pass_rate * 100, 1)}% (${s.pass}/${s.n})`);
    lines.push(`| ${cs.mode} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Pairwise agreement (across all seed-sample pairs)");
  lines.push("");
  for (const ag of agreements) {
    const aName = ag.mode_a;
    const bName = ag.mode_b;
    lines.push(`### ${aName} vs ${bName}`);
    lines.push("");
    lines.push("| | passed | failed |");
    lines.push("|---|---|---|");
    lines.push(`| **${aName} passed** | both: ${ag.both} | ${aName}-only: ${ag.a_only} |`);
    lines.push(`| **${aName} failed** | ${bName}-only: ${ag.b_only} | neither: ${ag.neither} |`);
    lines.push("");
    const aWins = ag.a_only;
    const bWins = ag.b_only;
    const netDelta = aWins - bWins;
    const totalPct = ag.total > 0 ? (netDelta / ag.total) * 100 : 0;
    lines.push(
      `Net: ${aName} wins ${aWins}, ${bName} wins ${bWins}, net Δ = **${netDelta > 0 ? "+" : ""}${netDelta}** (${totalPct > 0 ? "+" : ""}${fmt(totalPct, 1)} pp of ${ag.total} pairs).`
    );
    lines.push("");
  }

  lines.push("## How to read this");
  lines.push("");
  lines.push(
    "- A `+6 pp ± 2 pp` mean Δ pass-rate across N seeds is more credible than the same `+6 pp` from a single seeded run."
  );
  lines.push(
    "- Pairwise agreement (rightmost block) groups *every* (seed, sample) pair and counts the four cases. A consistent winner has high `a_only` and low `b_only` across all seeds."
  );
  lines.push(
    "- With only 3 seeds the stddev estimate is rough; a real Phase-1 experiment will rerun with 5-10 seeds before reporting in a paper."
  );
  return lines.join("\n") + "\n";
}

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { dirs: string[]; out: string } {
  const dirs: string[] = [];
  let out = "packages/compliance/benchmarks/ifeval/results-multi-seed";
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) {
      if (m[1] === "out") out = m[2] ?? out;
      continue;
    }
    dirs.push(a);
  }
  return { dirs, out };
}

async function main() {
  const { dirs, out } = parseArgs(process.argv.slice(2));
  if (dirs.length < 2) {
    console.error("usage: compare-seeds.ts <result_dir> <result_dir> [...] [--out=<dir>]");
    process.exit(1);
  }
  const seedRuns = dirs.map(loadSeedRun);
  const modes: RunMode[] = ["direct", "prompt_retry", "full_pcl"];
  const crossStats = modes.map((m) => aggregateAcrossSeeds(m, seedRuns));

  // Just the two interesting agreement comparisons for now.
  const agreements: PairwiseAgreement[] = [
    pairwiseAgreement("full_pcl", "prompt_retry", seedRuns),
    pairwiseAgreement("full_pcl", "direct", seedRuns),
  ];

  mkdirSync(out, { recursive: true });
  const md = buildMarkdown(seedRuns, crossStats, agreements);
  writeFileSync(join(out, "multi-seed-summary.md"), md);
  writeFileSync(
    join(out, "multi-seed-summary.json"),
    JSON.stringify({ crossStats, agreements }, null, 2)
  );

  console.error(`# wrote ${join(out, "multi-seed-summary.md")}`);
  console.error(`# wrote ${join(out, "multi-seed-summary.json")}`);
  console.error("");
  process.stdout.write(md);
}

await main();
