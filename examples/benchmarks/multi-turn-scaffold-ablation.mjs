#!/usr/bin/env node
/**
 * multi-turn-scaffold-ablation.mjs — V2 of the desktop-agent feasibility plan.
 *
 * Drives the five scaffold arms over multi-turn-tool-exec for any
 * combination of models. Each (arm × model × seed × item) cell produces
 * a pass/fail; we paired-test each scaffold arm against bare with McNemar
 * (the exact same primitive evals-runner ships in `stats/mcnemar.ts`).
 *
 * Why this script lives outside the package: the suites import
 * `@wasmagent/kernel-quickjs` lazily, but a benchmark run also wants to
 * call into ad-hoc model registries (Ollama-served evomerge GGUFs) and
 * fold them into a Pareto report. Keeping the logic here lets each side
 * stay generic — the suite knows about arms and judges, the script knows
 * about model fleets and reports.
 *
 * Usage:
 *   node examples/benchmarks/multi-turn-scaffold-ablation.mjs \
 *     --base-url http://localhost:11434/v1 \
 *     --models qwen2.5:0.5b,evomerge-qwen25-1b5:latest,p17-c3-imat_A_gsm512:latest \
 *     --arms bare,grammar,code,self-consist,full \
 *     --seeds 0,1,2 \
 *     --limit 6 \
 *     --out docs/reports/multi-turn-scaffold-ablation-2026-06-13
 *
 *   --models           Comma-separated Ollama model tags
 *   --arms             Subset of {bare,grammar,code,self-consist,full}
 *   --seeds            Comma-separated integers (default: 0,1,2)
 *   --limit            Cap items per arm (default: all 30; 6 = smoke)
 *   --base-url         OpenAI-compat endpoint (default: env $OPENAI_BASE_URL or http://localhost:11434/v1)
 *   --concurrency      Per-(model,arm) concurrency (default 1 — local Ollama only loads one model)
 *   --warmup / --no-warmup
 *   --out              Output directory for the markdown report + raw JSON
 *
 * Hardware: requires Ollama running locally with the listed models. No
 * GPU mandated — Apple Silicon Metal is enough for ≤2B Q4 models. The
 * smoke run (--limit 6) finishes a 5×3×3×6=270-cell grid in <30 minutes
 * on M-series hardware with a 1.5B model.
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
      arms: { type: "string", default: "bare,grammar,code,self-consist,full" },
      seeds: { type: "string", default: "0,1,2" },
      limit: { type: "string" },
      "base-url": { type: "string" },
      concurrency: { type: "string", default: "1" },
      warmup: { type: "boolean" },
      "no-warmup": { type: "boolean" },
      out: { type: "string" },
    },
  });

  if (!values.models) {
    console.error("Error: --models required (comma-separated Ollama tags)");
    process.exit(2);
  }
  const models = values.models.split(",").map((m) => m.trim()).filter(Boolean);
  const arms = values.arms.split(",").map((a) => a.trim()).filter(Boolean);
  const seeds = values.seeds.split(",").map((s) => Number.parseInt(s, 10));
  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
  const baseUrl = values["base-url"] ?? process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";
  const concurrency = Number.parseInt(values.concurrency ?? "1", 10);
  const warmup = values["no-warmup"] !== true;
  const today = new Date().toISOString().slice(0, 10);
  const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, "docs", "reports", `multi-turn-scaffold-ablation-${today}`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Resolve evals-runner from dist.
  const evalsPath = join(REPO_ROOT, "packages/evals-runner/dist/index.js");
  if (!existsSync(evalsPath)) {
    console.error("Error: @wasmagent/evals-runner is not built. Run: bun run -F '@wasmagent/evals-runner' build");
    process.exit(2);
  }
  const evals = await import(evalsPath);
  const armsModule = await import(join(REPO_ROOT, "packages/evals-runner/dist/suites/multi-turn-scaffold-arms.js"));
  const ABLATION_ARMS = armsModule.ABLATION_ARMS;

  // Build arm suites. If --limit is set, slice items in place (the script
  // owns the data — it's a one-shot benchmark, not a library).
  const selectedArmSuites = arms.map((armName) => {
    const suite = ABLATION_ARMS[armName];
    if (!suite) {
      console.error(`Unknown arm: ${armName}. Known: ${Object.keys(ABLATION_ARMS).join(",")}`);
      process.exit(2);
    }
    if (limit !== undefined) {
      return { ...suite, items: suite.items.slice(0, limit) };
    }
    return suite;
  });

  const modelSpecs = models.map((tag) => ({
    id: tag,
    modelId: tag,
    baseUrl,
    apiKey: "ollama",
  }));

  const startMs = Date.now();
  console.error(`[ablation] arms=${arms.join(",")} models=${models.join(",")} seeds=${seeds.join(",")} limit=${limit ?? "all"} concurrency=${concurrency}`);

  const report = await evals.runEvaluation({
    models: modelSpecs,
    suites: selectedArmSuites,
    seeds,
    concurrency,
    warmup,
    onProgress: (done, total, cell) => {
      if (done % 5 === 0 || done === total) {
        console.error(`[ablation] ${done}/${total}${cell?.modelId ? ` last=${cell.modelId}/${cell.itemId}/${cell.passed ? "✓" : "✗"} (${cell.wallMs}ms)` : ""}`);
      }
    },
  });

  // Summary console output.
  console.error("\n[ablation] Aggregates:");
  for (const a of report.aggregates) {
    console.error(
      `  ${a.modelId} × ${a.suiteName}: meanAcc=${(a.meanAcc * 100).toFixed(1)}%  pooled=${a.passedCells}/${a.totalCells}  Wilson=[${(a.wilsonLo * 100).toFixed(1)}, ${(a.wilsonHi * 100).toFixed(1)}]  p95Wall=${a.p95WallMs.toFixed(0)}ms  warmup=${a.warmupMs}ms`,
    );
  }

  // Paired McNemar of each non-bare arm vs bare, per model.
  const bareName = "mt-tool-exec.arm-a-bare";
  console.error("\n[ablation] McNemar exact (vs bare):");
  const mcnemarRows = [];
  for (const model of models) {
    for (const arm of arms) {
      if (arm === "bare") continue;
      const armSuiteName = ABLATION_ARMS[arm].name;
      const bareCells = report.cells.filter(
        (c) => c.modelId === model && c.trace.traceId.includes(`${bareName}::`),
      );
      const armCells = report.cells.filter(
        (c) => c.modelId === model && c.trace.traceId.includes(`${armSuiteName}::`),
      );
      const pairs = [];
      for (const b of bareCells) {
        const a = armCells.find((x) => x.itemId === b.itemId && x.seed === b.seed);
        if (a) pairs.push({ bare: b.passed, arm: a.passed });
      }
      const b01 = pairs.filter((p) => !p.bare && p.arm).length; // arm wins
      const b10 = pairs.filter((p) => p.bare && !p.arm).length; // arm loses
      const both = pairs.filter((p) => p.bare && p.arm).length;
      const neither = pairs.filter((p) => !p.bare && !p.arm).length;
      const r = evals.mcnemarExact(b01, b10);
      mcnemarRows.push({ model, arm, b01, b10, both, neither, p: r.pTwoSided ?? r.pValue ?? r });
      console.error(`  ${model} × ${arm} vs bare: arm-wins=${b01} bare-wins=${b10} both=${both} neither=${neither} p=${typeof r === "object" ? JSON.stringify(r) : r}`);
    }
  }

  // Pareto: produce 3-axis table per arm (acc × p95 wall × model size).
  // Model size isn't known here in bytes (Ollama tags hide it), so we
  // tag it via env (pass --sizes 0.5b=450,1.5b=1100,...) — for now we
  // print acc × p95 only and note size gap.
  const md = renderReport({
    title: `Multi-turn scaffold ablation — ${today}`,
    arms,
    models,
    seeds,
    limit,
    baseUrl,
    aggregates: report.aggregates,
    mcnemar: mcnemarRows,
    totalMs: Date.now() - startMs,
  });
  const reportPath = join(outDir, "report.md");
  const jsonPath = join(outDir, "raw.json");
  writeFileSync(reportPath, md, "utf8");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.error(`\n[ablation] report → ${reportPath}`);
  console.error(`[ablation] raw    → ${jsonPath}`);
}

function renderReport({ title, arms, models, seeds, limit, baseUrl, aggregates, mcnemar, totalMs }) {
  const lines = [];
  lines.push(`# ${title}`, "");
  lines.push(`**Models:** ${models.join(", ")}  `);
  lines.push(`**Arms:** ${arms.join(", ")}  `);
  lines.push(`**Seeds:** ${seeds.join(", ")}  `);
  lines.push(`**Items per arm:** ${limit ?? "all 30"}  `);
  lines.push(`**Endpoint:** \`${baseUrl}\`  `);
  lines.push(`**Total wall:** ${(totalMs / 1000).toFixed(1)}s`, "");
  lines.push("## Per-(model, arm) accuracy", "");
  lines.push("| model | arm | passed/total | mean acc | Wilson 95% | p95 wall (ms) |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const a of aggregates) {
    lines.push(
      `| ${a.modelId} | ${a.suiteName.replace("mt-tool-exec.arm-", "")} | ${a.passedCells}/${a.totalCells} | ${(a.meanAcc * 100).toFixed(1)}% | [${(a.wilsonLo * 100).toFixed(1)}, ${(a.wilsonHi * 100).toFixed(1)}] | ${a.p95WallMs.toFixed(0)} |`,
    );
  }
  lines.push("", "## McNemar exact (each arm vs bare)", "");
  lines.push("| model | arm | arm-wins | bare-wins | both | neither | p (two-sided) |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const m of mcnemar) {
    const pStr = typeof m.p === "number" ? m.p.toExponential(2) : JSON.stringify(m.p);
    lines.push(`| ${m.model} | ${m.arm} | ${m.b01} | ${m.b10} | ${m.both} | ${m.neither} | ${pStr} |`);
  }
  lines.push("", "## Reading the report", "");
  lines.push("- **arm-wins**: cells where arm passed AND bare failed (the win-conditioned cells McNemar uses).");
  lines.push("- **bare-wins**: cells where bare passed AND arm failed. McNemar's test asks whether `arm-wins > bare-wins` significantly.");
  lines.push("- **G0 threshold**: any ≤2B/≤1.2GB model under the **full** arm reaches ≥50% mean acc, AND McNemar p<0.05 vs bare.");
  lines.push("- Wilson CI is on pooled (seed × item) cells. Wide CIs mean increase --limit and re-run.");
  return lines.join("\n");
}

main().catch((e) => {
  console.error("[ablation] fatal:", e);
  process.exit(1);
});
