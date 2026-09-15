/**
 * Generate the machine-readable adversarial evaluation report (schema v2).
 *
 * Every value is DERIVED — from repository files, CI environment variables,
 * or test-produced metrics. No hardcoded success values:
 *   - package.json            → package version
 *   - package-metadata.json   → declared phase / adversarial evaluation
 *   - evals/corpus/*.jsonl    → split counts + redteam presence
 *   - evals/results/structural-escape-metrics.json → escape rates (written
 *     by structural-mutation-escape.test.ts during the F5 job)
 *   - CI env / git            → tested merge SHA, PR head SHA, base SHA
 *
 * The job FAILS (exit 1) when the artifact would contradict itself — e.g.
 * declaring phase F2 while promotion_eligible is false or any F2 escape
 * metric is missing or non-zero (final-audit C2).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, validatePromotionState } from "./adversarial-report.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function countJsonl(p) {
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const pkg = readJson(join(pkgRoot, "package.json"));
const metadata = readJson(join(pkgRoot, "package-metadata.json"));

const corpusDir = join(pkgRoot, "evals", "corpus");
const corpus = {
  train_count: countJsonl(join(corpusDir, "train.jsonl")),
  dev_count: countJsonl(join(corpusDir, "dev.jsonl")),
  holdout_count: countJsonl(join(corpusDir, "holdout.jsonl")),
  redteam_count: countJsonl(join(corpusDir, "redteam.jsonl")),
  external_count: countJsonl(join(corpusDir, "external.jsonl")),
};

// Escape metrics are produced by the F5 test job. When the metrics file is
// absent (e.g. running the report standalone), rates are null — never 0.
let metrics = {
  text_mutation_escape_rate: null,
  structural_mutation_escape_rate: null,
  combined_escape_rate: null,
  scenario_counts: null,
};
const metricsPath = join(pkgRoot, "evals", "results", "structural-escape-metrics.json");
if (existsSync(metricsPath)) {
  const m = readJson(metricsPath);
  metrics = {
    text_mutation_escape_rate: m.text_mutation_escape_rate ?? null,
    structural_mutation_escape_rate: m.structural_mutation_escape_rate ?? null,
    combined_escape_rate: m.combined_escape_rate ?? null,
    scenario_counts: m.scenario_counts ?? null,
  };
}

const baseRef = process.env.GITHUB_BASE_REF ?? null;
// Base SHA: merge-base against the PR base when the full history is present
// (checkout with fetch-depth: 0); null otherwise — never a guess.
let baseSha = null;
if (baseRef) baseSha = git(`merge-base HEAD "origin/${baseRef}"`);

const report = buildReport({
  pkg,
  metadata,
  corpus,
  metrics,
  identity: {
    // On pull_request events GITHUB_SHA is the SYNTHETIC MERGE commit —
    // recorded as tested_merge_sha, distinct from the PR head SHA.
    github_sha: process.env.GITHUB_SHA ?? git("rev-parse HEAD"),
    event_name: process.env.GITHUB_EVENT_NAME ?? null,
    pr_head_sha: process.env.PR_HEAD_SHA ?? null,
    base_ref: baseRef,
    head_ref: process.env.GITHUB_HEAD_REF ?? null,
    base_sha: baseSha,
  },
  generated_at: new Date().toISOString(),
});

const validation = validatePromotionState(report);

const outDir = join(pkgRoot, "evals", "results");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "mcp-firewall-adversarial-report-latest.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`adversarial report (v2) written to ${outPath}`);
console.log(JSON.stringify(report, null, 2));

if (!validation.valid) {
  console.error("\nadversarial report FAILED promotion-state validation:");
  for (const e of validation.errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("\npromotion-state validation: OK");
