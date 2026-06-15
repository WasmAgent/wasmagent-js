/**
 * Markdown renderer for `EvaluationReport`. The output is the canonical
 * artifact of an evaluation run — paste-ready into PRs, commit messages,
 * release notes, or `docs/benchmarks.md`.
 *
 * Three sections:
 *   1. Headline table — one row per (model, suite). Mean acc + Wilson CI +
 *      total cost + p95 wall (steady-state, warmup separate) + Pareto-front flag.
 *   2. Per-suite breakdown — one table per suite, models as rows, items
 *      as columns. Cells show pass/fail at the per-seed level.
 *   3. Cross-model McNemar comparison — pairwise paired-test table per suite
 *      (only when ≥2 models and ≥3 seeds). "NOT-FOR-CLAIMS" watermark when
 *      n < 50 or seeds < 3.
 *   4. Configuration footer — seeds, warm-up, totals, started-at timestamp.
 */

import { mcnemarExact } from "./stats/mcnemar.js";
import type { EvaluationReport, RunResult, SuiteAggregate } from "./types.js";

/** Minimum item count for a McNemar comparison to be claims-worthy. */
const MIN_N_FOR_CLAIMS = 50;

export function renderReportMarkdown(report: EvaluationReport): string {
  const out: string[] = [];

  // ── NOT-FOR-CLAIMS watermark ──────────────────────────────────────────────
  const maxN = Math.max(
    ...report.aggregates.map((a) => a.totalCells / Math.max(report.seeds.length, 1)),
    0
  );
  const nSeeds = report.seeds.length;
  const notForClaims = nSeeds < 3 || maxN < MIN_N_FOR_CLAIMS;
  if (notForClaims) {
    out.push(
      `> ⚠️ **NOT-FOR-CLAIMS**: This run has ${nSeeds} seed(s) and ≤${Math.ceil(maxN)} items/suite.`
    );
    out.push(
      `> Paired McNemar requires ≥3 seeds and ≥${MIN_N_FOR_CLAIMS} items for a statistically valid comparison.`
    );
    out.push(
      `> Wilson CIs here are for exploration only — differences ≤10pp are indistinguishable at this n.`
    );
    out.push("");
  }

  out.push(`# Evaluation Report`);
  out.push("");
  out.push(`> **Started:** ${report.startedAt}`);
  out.push(
    `> **Wall:** ${(report.totalMs / 1000).toFixed(1)} s · **Models:** ${report.models.length} · **Suites:** ${report.suites.length} · **Seeds:** ${report.seeds.length} (${report.seeds.join(", ")})`
  );
  if (report.warmup !== false) {
    const warmupSummary = report.aggregates
      .filter((a, i, arr) => arr.findIndex((x) => x.modelId === a.modelId) === i)
      .map((a) => `${a.modelId}=${a.warmupMs}ms`)
      .join(", ");
    out.push(`> **Warm-up:** enabled — cold-load ms: ${warmupSummary || "n/a"}`);
    out.push(`> **p95 wall below is steady-state only** (warm-up excluded).`);
  } else {
    out.push(`> ⚠️ **Warm-up: disabled** — p95 wall may include cold model-loading time.`);
  }
  out.push("");

  out.push(`## Summary`);
  out.push("");
  out.push(
    "| Suite | Model | Mean acc | 95% Wilson | σ across seeds | Tokens | Cost (USD) | p95 wall (ms) | Warm-up (ms) | Pareto |"
  );
  out.push("|---|---|---:|:-:|---:|---:|---:|---:|---:|:-:|");
  for (const suiteSummary of report.suites) {
    const suiteName = suiteSummary.name;
    const inSuite = report.aggregates.filter((a) => a.suiteName === suiteName);
    const paretoEntry = report.pareto.find((p) => p.suiteName === suiteName);
    const paretoIds = new Set(paretoEntry?.front.map((f) => f.modelId) ?? []);
    for (const a of inSuite) {
      const onPareto = paretoIds.has(a.modelId);
      out.push(
        `| \`${suiteName}\` | \`${a.modelId}\` | **${(a.meanAcc * 100).toFixed(1)}%** ` +
          `| [${(a.wilsonLo * 100).toFixed(1)}%, ${(a.wilsonHi * 100).toFixed(1)}%] ` +
          `| ${(a.seedStd * 100).toFixed(2)}pp ` +
          `| ${a.totalTokens.toLocaleString()} ` +
          `| $${a.totalCostUsd.toFixed(4)} ` +
          `| ${Math.round(a.p95WallMs).toLocaleString()} ` +
          `| ${a.warmupMs > 0 ? Math.round(a.warmupMs).toLocaleString() : "—"} ` +
          `| ${onPareto ? "★" : ""} |`
      );
    }
  }
  out.push("");

  // Pareto callout
  out.push(`### Pareto front`);
  out.push("");
  out.push(
    "A model is on the Pareto front for a suite if no other model has " +
      "**at least its accuracy AND lower-or-equal cost AND lower-or-equal p95 wall**, " +
      "with at least one strict win. ★ = on the front."
  );
  out.push("");

  // Per-suite per-item breakdown.
  for (const suiteSummary of report.suites) {
    const cells = report.cells.filter((c) =>
      report.aggregates.some((a) => a.suiteName === suiteSummary.name && a.modelId === c.modelId)
    );
    // Determine the actual items for this suite from the cells
    const itemIds = Array.from(new Set(cells.map((c) => c.itemId))).sort();
    if (itemIds.length === 0) continue;

    out.push(`## Suite \`${suiteSummary.name}\` — ${suiteSummary.title}`);
    out.push("");
    out.push(`> ${suiteSummary.description}`);
    out.push("");

    // Per-item × per-model pass matrix (collapsed across seeds: ✓ if all
    // seeds passed, ✗ if all failed, △ if split).
    const modelIds = Array.from(new Set(cells.map((c) => c.modelId)));
    const head = ["Model", ...itemIds, "All-seed acc"];
    out.push(`| ${head.join(" | ")} |`);
    out.push(`|${head.map(() => "---").join("|")}|`);
    for (const modelId of modelIds) {
      const row = [`\`${modelId}\``];
      let totalPass = 0;
      let totalCells = 0;
      for (const itemId of itemIds) {
        const itemCells = cells.filter((c) => c.modelId === modelId && c.itemId === itemId);
        if (itemCells.length === 0) {
          row.push("·");
          continue;
        }
        const passed = itemCells.filter((c) => c.passed).length;
        totalPass += passed;
        totalCells += itemCells.length;
        if (passed === itemCells.length) row.push("✓");
        else if (passed === 0) row.push("✗");
        else row.push(`△${passed}/${itemCells.length}`);
      }
      const acc = totalCells === 0 ? 0 : totalPass / totalCells;
      row.push(`${(acc * 100).toFixed(1)}%`);
      out.push(`| ${row.join(" | ")} |`);
    }
    out.push("");
  }

  // ── Cross-model McNemar comparison ─────────────────────────────────────────
  if (report.models.length >= 2) {
    out.push(`## Cross-model paired comparison (McNemar)`);
    out.push("");

    if (notForClaims) {
      out.push(
        `> ⚠️ **NOT-FOR-CLAIMS**: n < ${MIN_N_FOR_CLAIMS} items or seeds < 3. These p-values are exploratory only.`
      );
      out.push("");
    } else {
      out.push(`> Pooled across seeds. b = candidate-correct/baseline-wrong; c = opposite.`);
      out.push(`> p < 0.05 indicates statistically significant difference.`);
      out.push("");
    }

    for (const suiteSummary of report.suites) {
      const suiteCells = report.cells.filter((c) =>
        report.aggregates.some((a) => a.suiteName === suiteSummary.name && a.modelId === c.modelId)
      );
      const suiteModels = report.models.filter((m) =>
        report.aggregates.some((a) => a.suiteName === suiteSummary.name && a.modelId === m.id)
      );
      if (suiteModels.length < 2) continue;

      out.push(`### Suite \`${suiteSummary.name}\``);
      out.push("");
      out.push(`| Candidate | Baseline | b | c | Δacc | McNemar p | Verdict |`);
      out.push(`|---|---|---:|---:|---:|---:|---|`);

      for (let i = 0; i < suiteModels.length; i++) {
        for (let j = 0; j < suiteModels.length; j++) {
          if (i === j) continue;
          const cand = suiteModels[i]!;
          const base = suiteModels[j]!;

          // Build pooled b/c across all seeds and items.
          let b = 0;
          let c = 0;
          let pooledN = 0;
          let pooledCandPass = 0;
          let pooledBasePass = 0;

          const itemIds = Array.from(new Set(suiteCells.map((cell) => cell.itemId)));
          for (const seed of report.seeds) {
            for (const itemId of itemIds) {
              const candCell = suiteCells.find(
                (cell) => cell.modelId === cand.id && cell.seed === seed && cell.itemId === itemId
              );
              const baseCell = suiteCells.find(
                (cell) => cell.modelId === base.id && cell.seed === seed && cell.itemId === itemId
              );
              if (!candCell || !baseCell) continue;
              pooledN++;
              const cp = candCell.passed;
              const bp = baseCell.passed;
              if (cp) pooledCandPass++;
              if (bp) pooledBasePass++;
              if (cp && !bp) b++;
              else if (!cp && bp) c++;
            }
          }

          const { p } = mcnemarExact(b, c);
          const deltaAcc = pooledN > 0 ? (pooledCandPass - pooledBasePass) / pooledN : 0;
          const verdictIcon = notForClaims
            ? "—"
            : p < 0.05
              ? deltaAcc > 0
                ? "✅ sig. better"
                : "❌ sig. worse"
              : "≈ not significant";

          out.push(
            `| \`${cand.id}\` | \`${base.id}\` ` +
              `| ${b} | ${c} ` +
              `| ${deltaAcc >= 0 ? "+" : ""}${(deltaAcc * 100).toFixed(1)}pp ` +
              `| ${p.toFixed(3)}${notForClaims ? "†" : ""} ` +
              `| ${verdictIcon} |`
          );
        }
      }
      if (notForClaims) {
        out.push(
          `> † p-values marked with † are NOT-FOR-CLAIMS (n < ${MIN_N_FOR_CLAIMS} or seeds < 3).`
        );
      }
      out.push("");
    }
  }

  // Footer.
  out.push(`## Configuration`);
  out.push("");
  out.push("| Model | Base URL | model id | Temp | $/M in | $/M out |");
  out.push("|---|---|---|---:|---:|---:|");
  for (const m of report.models) {
    out.push(
      `| \`${m.id}\` | \`${m.baseUrl}\` | \`${m.modelId ?? m.id}\` ` +
        `| ${m.temperature ?? 0} ` +
        `| $${(m.pricePer1MInput ?? 0).toFixed(2)} ` +
        `| $${(m.pricePer1MOutput ?? 0).toFixed(2)} |`
    );
  }
  out.push("");
  return out.join("\n");
}

/**
 * Convenience: generate a tighter "single-line per (model, suite)" version
 * suitable for fitting into commit messages or status bars.
 */
export function renderReportCompact(aggregates: SuiteAggregate[]): string {
  return aggregates
    .map(
      (a) =>
        `${a.modelId}/${a.suiteName}: ${(a.meanAcc * 100).toFixed(1)}% ` +
        `(σ ${(a.seedStd * 100).toFixed(1)}pp, ` +
        `$${a.totalCostUsd.toFixed(3)}, ` +
        `p95 ${Math.round(a.p95WallMs)}ms, ` +
        `warmup ${a.warmupMs > 0 ? Math.round(a.warmupMs) + "ms" : "—"})`
    )
    .join("\n");
}
