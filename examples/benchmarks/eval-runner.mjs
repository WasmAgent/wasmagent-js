#!/usr/bin/env node
/**
 * eval-runner.mjs — generic benchmark driver over any combination of
 * REFERENCE_SUITES from @agentkit-js/evals-runner. Used for:
 *
 *   - LoCoMo-Refined / MemoryAgentBench memory evals
 *   - longContextRecall / multiTurnMemory / toolSequence / agentTrajectory
 *   - any future suite that opts into the runItem hook contract
 *
 * For the multi-turn-tool-exec scaffold ablation arms (arm-a..arm-f),
 * use multi-turn-scaffold-ablation.mjs instead — it knows about ARMS
 * specifically.
 *
 * Usage:
 *   node examples/benchmarks/eval-runner.mjs \
 *     --base-url http://localhost:11434/v1 \
 *     --models qwen2.5:0.5b,evomerge-qwen25-1b5:latest \
 *     --suites locomo-refined,memory-agent-bench \
 *     --seeds 0,1,2 \
 *     --out docs/reports/memory-eval-2026-06-14
 *
 *   --models <a,b,c>      Comma-sep Ollama / OpenAI-compat tags
 *   --suites <a,b,c>      Comma-sep names from REFERENCE_SUITES
 *   --seeds <0,1,2>       Default 0,1,2
 *   --limit N             Cap items per suite (smoke runs)
 *   --base-url URL        Default $OPENAI_BASE_URL or http://localhost:11434/v1
 *   --concurrency N       Per-(model,suite) concurrency (default 1)
 *   --no-warmup           Skip per-model warmup call
 *   --out DIR             Output dir (report.md + raw.json)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      suites: { type: "string" },
      seeds: { type: "string", default: "0,1,2" },
      limit: { type: "string" },
      "base-url": { type: "string" },
      concurrency: { type: "string", default: "1" },
      "no-warmup": { type: "boolean" },
      out: { type: "string" },
    },
  });

  if (!values.models || !values.suites) {
    console.error("Error: --models and --suites both required");
    console.error("Available suites depend on REFERENCE_SUITES in @agentkit-js/evals-runner.");
    process.exit(2);
  }
  const models = values.models.split(",").map((m) => m.trim()).filter(Boolean);
  const suiteNames = values.suites.split(",").map((s) => s.trim()).filter(Boolean);
  const seeds = values.seeds.split(",").map((s) => Number.parseInt(s, 10));
  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
  const baseUrl = values["base-url"] ?? process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";
  const concurrency = Number.parseInt(values.concurrency ?? "1", 10);
  const warmup = values["no-warmup"] !== true;
  const today = new Date().toISOString().slice(0, 10);
  const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, "docs", "reports", `eval-${today}`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const evalsPath = join(REPO_ROOT, "packages/evals-runner/dist/index.js");
  if (!existsSync(evalsPath)) {
    console.error("Error: @agentkit-js/evals-runner is not built. Run: bun run -F '@agentkit-js/evals-runner' build");
    process.exit(2);
  }
  const evals = await import(evalsPath);
  const REFERENCE_SUITES = evals.REFERENCE_SUITES;

  // Resolve suites by name; apply --limit if set.
  const selectedSuites = suiteNames.map((name) => {
    const suite = REFERENCE_SUITES[name];
    if (!suite) {
      console.error(`Unknown suite: ${name}. Known: ${Object.keys(REFERENCE_SUITES).join(", ")}`);
      process.exit(2);
    }
    return limit !== undefined ? { ...suite, items: suite.items.slice(0, limit) } : suite;
  });

  const modelSpecs = models.map((tag) => ({
    id: tag,
    modelId: tag,
    baseUrl,
    apiKey: "ollama",
  }));

  const startMs = Date.now();
  console.error(
    `[eval] suites=${suiteNames.join(",")} models=${models.join(",")} seeds=${seeds.join(",")} limit=${limit ?? "all"} concurrency=${concurrency}`,
  );

  const report = await evals.runEvaluation({
    models: modelSpecs,
    suites: selectedSuites,
    seeds,
    concurrency,
    warmup,
    onProgress: (done, total, cell) => {
      if (done % 10 === 0 || done === total) {
        console.error(
          `[eval] ${done}/${total}${cell?.modelId ? ` last=${cell.modelId}/${cell.itemId}/${cell.passed ? "✓" : "✗"} (${cell.wallMs}ms)` : ""}`,
        );
      }
    },
  });

  console.error("\n[eval] Aggregates:");
  for (const a of report.aggregates) {
    console.error(
      `  ${a.modelId} × ${a.suiteName}: meanAcc=${(a.meanAcc * 100).toFixed(1)}%  pooled=${a.passedCells}/${a.totalCells}  Wilson=[${(a.wilsonLo * 100).toFixed(1)}, ${(a.wilsonHi * 100).toFixed(1)}]  p95Wall=${a.p95WallMs.toFixed(0)}ms`,
    );
  }

  const md = renderReport({
    title: `Eval — ${today}`,
    suites: suiteNames,
    models,
    seeds,
    limit,
    baseUrl,
    aggregates: report.aggregates,
    totalMs: Date.now() - startMs,
  });
  const reportPath = join(outDir, "report.md");
  const jsonPath = join(outDir, "raw.json");
  writeFileSync(reportPath, md, "utf8");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.error(`\n[eval] report → ${reportPath}`);
  console.error(`[eval] raw    → ${jsonPath}`);
}

function renderReport({ title, suites, models, seeds, limit, baseUrl, aggregates, totalMs }) {
  const lines = [];
  lines.push(`# ${title}`, "");
  lines.push(`**Suites:** ${suites.join(", ")}  `);
  lines.push(`**Models:** ${models.join(", ")}  `);
  lines.push(`**Seeds:** ${seeds.join(", ")}  `);
  lines.push(`**Items per suite:** ${limit ?? "all"}  `);
  lines.push(`**Endpoint:** \`${baseUrl}\`  `);
  lines.push(`**Total wall:** ${(totalMs / 1000).toFixed(1)}s`, "");
  lines.push("## Per-(model, suite) accuracy", "");
  lines.push("| model | suite | passed/total | mean acc | Wilson 95% | p95 wall (ms) |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const a of aggregates) {
    lines.push(
      `| ${a.modelId} | ${a.suiteName} | ${a.passedCells}/${a.totalCells} | ${(a.meanAcc * 100).toFixed(1)}% | [${(a.wilsonLo * 100).toFixed(1)}, ${(a.wilsonHi * 100).toFixed(1)}] | ${a.p95WallMs.toFixed(0)} |`,
    );
  }
  return lines.join("\n");
}

main().catch((e) => {
  console.error("[eval] fatal:", e);
  process.exit(1);
});
