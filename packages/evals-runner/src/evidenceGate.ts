/**
 * Evidence gate — admit or reject EvidenceRow objects and produce a report.
 *
 * Three operations:
 *   1. `admitRows`   — run EvidenceAdmissionContract rules against a batch of rows
 *   2. `gateReport`  — render admitted vs rejected rows as Markdown
 *   3. CLI via `wasmagent-evals evidence-gate` (see cli.ts)
 *
 * Usage:
 * ```ts
 * import { admitRows, gateReport } from "@wasmagent/evals-runner/evidence-gate";
 *
 * const contract = { workloadId: "bscode-worker", ... };
 * const rows = [{ rowId: "r1", type: "admitted", evidenceRef: "sha256:abc" }];
 * const result = admitRows(contract, rows);
 * console.log(gateReport(result));
 * ```
 */

// ── Local type definitions (structural mirrors of @wasmagent/compliance) ─────
// Inlined to avoid adding a hard dependency on @wasmagent/compliance.

export type EvidenceRowType = "admitted" | "smoke" | "diagnostic" | "fixture";
export type ReplayPolicy = "deterministic" | "stochastic" | "none";
export type RedactionPolicy = "none" | "pii" | "full";
export type RuntimeSetting = "sandbox" | "live" | "replay";

export type AdmissionEvaluator = (evidence: unknown) => boolean;

export interface AdmissionRule {
  ruleId: string;
  description: string;
  evaluator: AdmissionEvaluator;
}

export interface EvidenceAdmissionContract {
  workloadId: string;
  driverName: string;
  runtimeSetting: RuntimeSetting;
  schemaVersion: string;
  replayPolicy: ReplayPolicy;
  admissionRules: AdmissionRule[];
  redactionPolicy: RedactionPolicy;
}

export interface EvidenceRow {
  rowId: string;
  type: EvidenceRowType;
  evidenceRef: string;
  admittedAt?: number;
  rejectionReason?: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GateDecision {
  rowId: string;
  originalType: EvidenceRowType;
  finalType: EvidenceRowType;
  /** Rule that caused a downgrade, if any. */
  downgradeRuleId?: string;
  downgradeReason?: string;
}

export interface GateResult {
  contractWorkloadId: string;
  contractDriverName: string;
  runtimeSetting: string;
  totalRows: number;
  admitted: number;
  smoke: number;
  diagnostic: number;
  fixture: number;
  rejected: number; // rows downgraded from admitted → lower tier
  decisions: GateDecision[];
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Run admission rules against a batch of EvidenceRows.
 *
 * Rules can downgrade a row's type (e.g. admitted → smoke).
 * Rows that start as smoke/diagnostic/fixture are never upgraded.
 * Rules are only applied to rows whose initial type is "admitted".
 */
export function admitRows(contract: EvidenceAdmissionContract, rows: EvidenceRow[]): GateResult {
  const decisions: GateDecision[] = [];
  let admitted = 0,
    smoke = 0,
    diagnostic = 0,
    fixture = 0,
    rejected = 0;

  for (const row of rows) {
    let finalType = row.type;
    let downgradeRuleId: string | undefined;
    let downgradeReason: string | undefined;

    // Only run rules on rows claiming to be "admitted"
    if (row.type === "admitted") {
      for (const rule of contract.admissionRules) {
        const passes = rule.evaluator(row);
        if (!passes) {
          finalType = "smoke";
          downgradeRuleId = rule.ruleId;
          downgradeReason = rule.description;
          rejected++;
          break;
        }
      }
      if (finalType === "admitted") admitted++;
    } else {
      if (row.type === "smoke") smoke++;
      else if (row.type === "diagnostic") diagnostic++;
      else if (row.type === "fixture") fixture++;
    }

    decisions.push({
      rowId: row.rowId,
      originalType: row.type,
      finalType,
      ...(downgradeRuleId !== undefined ? { downgradeRuleId } : {}),
      ...(downgradeReason !== undefined ? { downgradeReason } : {}),
    });
  }

  return {
    contractWorkloadId: contract.workloadId,
    contractDriverName: contract.driverName,
    runtimeSetting: contract.runtimeSetting,
    totalRows: rows.length,
    admitted,
    smoke,
    diagnostic,
    fixture,
    rejected,
    decisions,
  };
}

// ── Report renderer ──────────────────────────────────────────────────────────

/**
 * Render a GateResult as a Markdown report.
 *
 * admitted rows  → claim-eligible (may appear in README/paper numbers)
 * smoke rows     → CI regression only
 * rejected rows  → were "admitted" but failed a rule; shown as "downgraded"
 */
export function gateReport(result: GateResult): string {
  const lines: string[] = [];
  const total = result.totalRows;
  const admitPct = total > 0 ? ((result.admitted / total) * 100).toFixed(1) : "0.0";

  lines.push("# Evidence Gate Report");
  lines.push("");
  lines.push(`> **Workload:** ${result.contractWorkloadId}  `);
  lines.push(`> **Driver:** ${result.contractDriverName}  `);
  lines.push(`> **Runtime:** ${result.runtimeSetting}`);
  lines.push("");

  // Watermark when admission rate is low
  if (result.admitted < 3 || (total > 0 && result.admitted / total < 0.5)) {
    lines.push(
      `> ⚠️ **LOW ADMISSION RATE** (${admitPct}%): fewer than expected rows admitted. ` +
        `Check rule coverage before citing these numbers in public claims.`
    );
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("| Category | Count | Claim-eligible? |");
  lines.push("|---|---|---|");
  lines.push(`| ✅ admitted | ${result.admitted} | **Yes** |`);
  lines.push(`| 🔬 smoke | ${result.smoke} | No — CI only |`);
  lines.push(`| 🔧 diagnostic | ${result.diagnostic} | No |`);
  lines.push(`| 📎 fixture | ${result.fixture} | No |`);
  lines.push(`| ⬇️ downgraded (was admitted) | ${result.rejected} | No |`);
  lines.push(`| **Total** | **${total}** | — |`);
  lines.push("");
  lines.push(`Admission rate: **${admitPct}%** (${result.admitted} / ${total})`);
  lines.push("");

  // Downgraded rows detail
  const downgraded = result.decisions.filter((d) => d.downgradeRuleId);
  if (downgraded.length > 0) {
    lines.push("## Downgraded rows");
    lines.push("");
    lines.push("These rows were claimed as `admitted` but failed an admission rule:");
    lines.push("");
    lines.push("| Row ID | Failed rule | Reason |");
    lines.push("|---|---|---|");
    for (const d of downgraded) {
      lines.push(`| \`${d.rowId}\` | \`${d.downgradeRuleId}\` | ${d.downgradeReason ?? "—"} |`);
    }
    lines.push("");
  }

  // Admitted rows
  const admittedDecisions = result.decisions.filter((d) => d.finalType === "admitted");
  if (admittedDecisions.length > 0) {
    lines.push("## Admitted rows (claim-eligible)");
    lines.push("");
    for (const d of admittedDecisions) {
      lines.push(`- \`${d.rowId}\``);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Generated by `@wasmagent/evals-runner` evidence gate. " +
      "Only `admitted` rows may appear in public benchmark claims._"
  );

  return lines.join("\n");
}
