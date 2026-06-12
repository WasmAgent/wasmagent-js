/**
 * Markdown renderer for `EvaluationReport`. The output is the canonical
 * artifact of an evaluation run — paste-ready into PRs, commit messages,
 * release notes, or `docs/benchmarks.md`.
 *
 * Three sections:
 *   1. Headline table — one row per (model, suite). Mean acc + Wilson CI +
 *      total cost + p95 wall + Pareto-front flag.
 *   2. Per-suite breakdown — one table per suite, models as rows, items
 *      as columns. Cells show pass/fail at the per-seed level.
 *   3. Configuration footer — seeds, totals, started-at timestamp.
 */

import type { EvaluationReport, SuiteAggregate } from "./types.js";

export function renderReportMarkdown(report: EvaluationReport): string {
  const out: string[] = [];
  out.push(`# Evaluation Report`);
  out.push("");
  out.push(`> **Started:** ${report.startedAt}`);
  out.push(
    `> **Wall:** ${(report.totalMs / 1000).toFixed(1)} s · **Models:** ${report.models.length} · **Suites:** ${report.suites.length} · **Seeds:** ${report.seeds.length} (${report.seeds.join(", ")})`
  );
  out.push("");

  out.push(`## Summary`);
  out.push("");
  out.push(
    "| Suite | Model | Mean acc | 95% Wilson | σ across seeds | Tokens | Cost (USD) | p95 wall (ms) | Pareto |"
  );
  out.push("|---|---|---:|:-:|---:|---:|---:|---:|:-:|");
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
        `p95 ${Math.round(a.p95WallMs)}ms)`
    )
    .join("\n");
}
