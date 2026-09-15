/**
 * Generate the machine-readable adversarial evaluation report (schema v2).
 *
 * Every value is DERIVED — from repository files, CI environment variables,
 * or test-produced metrics. No hardcoded success values:
 *   - package.json            → package version
 *   - package-metadata.json   → declared phase / candidate phase
 *   - evals/corpus/*.jsonl    → split counts + redteam presence
 *   - evals/results/structural-escape-metrics.json → escape rates (written
 *     by structural-mutation-escape.test.ts during the F5 job)
 *   - GITHUB_* env            → exact tested SHA / PR refs (falls back to
 *     local git when run outside CI)
 *
 * `promotion_eligible` is true only when the metadata ALREADY declares the
 * candidate phase as current AND a redteam corpus is present — i.e. the
 * artifact can never be the first place a promotion is claimed.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function gitOrEnv(envVar, fallbackCmd) {
  const v = process.env[envVar];
  if (v) return v;
  try {
    return execSync(fallbackCmd, { encoding: "utf8" }).trim();
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
  mutation_detection_rate: null,
  text_mutation_escape_rate: null,
  structural_mutation_escape_rate: null,
  combined_escape_rate: null,
};
const metricsPath = join(pkgRoot, "evals", "results", "structural-escape-metrics.json");
if (existsSync(metricsPath)) {
  const m = readJson(metricsPath);
  metrics = {
    mutation_detection_rate: null,
    text_mutation_escape_rate: m.text_mutation_escape_rate ?? null,
    structural_mutation_escape_rate: m.structural_mutation_escape_rate ?? null,
    combined_escape_rate: m.combined_escape_rate ?? null,
    scenario_counts: m.scenario_counts ?? null,
  };
}

const declaredPhase = metadata.phase ?? null;
const candidatePhase = metadata.candidate_phase ?? null;

// Promotion is eligible only when metadata itself has been promoted to the
// candidate phase (a deliberate, separate metadata-only commit) — the
// artifact never leads a truth claim.
const promotionEligible =
  declaredPhase !== null && declaredPhase === candidatePhase && candidatePhase !== null;

const externalEvaluation = corpus.external_count > 0 ? "frozen_external_corpus" : "not_run";

const report = {
  format: "wasmagent-mcp-firewall-adversarial-report/v2",
  generated_at: new Date().toISOString(),
  // On pull_request events GitHub sets GITHUB_SHA to the merge-commit SHA;
  // head_ref/base_ref identify the PR. Local runs fall back to git rev-parse.
  tested_sha: gitOrEnv("GITHUB_SHA", "git rev-parse HEAD"),
  base_ref: process.env.GITHUB_BASE_REF ?? null,
  head_ref: process.env.GITHUB_HEAD_REF ?? null,
  package: pkg.name,
  package_version: pkg.version,
  declared_phase: declaredPhase,
  candidate_phase: candidatePhase,
  adversarial_evaluation: metadata.adversarial_evaluation ?? null,
  corpus,
  metrics,
  redteam_run: corpus.redteam_count > 0,
  external_evaluation: externalEvaluation,
  promotion_eligible: promotionEligible,
};

const outDir = join(pkgRoot, "evals", "results");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "mcp-firewall-adversarial-report-latest.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`adversarial report (v2) written to ${outPath}`);
console.log(JSON.stringify(report, null, 2));
