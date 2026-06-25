/**
 * EvidenceAdmission — typed contracts for evidence row admission and gating.
 *
 * Defines which agent evaluation rows may be cited in public claims (README
 * percentages, paper numbers, leaderboard entries) versus rows that are only
 * diagnostic or fixture-level.
 *
 * This file is types + Zod schemas only — no runtime logic. The admission
 * evaluator (a predicate function) intentionally lives only in the
 * `AdmissionRule` interface, not in the Zod schema, because functions are
 * not serializable to JSON.
 */

import { z } from "zod";

// ── Enums / union types ──────────────────────────────────────────────────────

/**
 * admitted  — may be cited in public claims (paper / README / leaderboard).
 * smoke     — CI regression signal only; not claim-eligible.
 * diagnostic— developer debugging; not claim-eligible.
 * fixture   — onboarding / example data; not claim-eligible.
 */
export const EvidenceRowTypeSchema = z.enum(["admitted", "smoke", "diagnostic", "fixture"]);
export type EvidenceRowType = z.infer<typeof EvidenceRowTypeSchema>;

export const ReplayPolicySchema = z.enum(["deterministic", "stochastic", "none"]);
export type ReplayPolicy = z.infer<typeof ReplayPolicySchema>;

export const RedactionPolicySchema = z.enum(["none", "pii", "full"]);
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>;

export const RuntimeSettingSchema = z.enum(["sandbox", "live", "replay"]);
export type RuntimeSetting = z.infer<typeof RuntimeSettingSchema>;

// ── Runtime-only type (not in Zod — function field) ─────────────────────────

/** Sync predicate over an arbitrary evidence object. */
export type AdmissionEvaluator = (evidence: unknown) => boolean;

/**
 * One admission rule. The `evaluator` function is intentionally absent from
 * the Zod wire schema (`EvidenceAdmissionContractSchema`) because functions
 * cannot be round-tripped through JSON. When deserializing, callers must
 * re-attach evaluators from their rule registry.
 */
export interface AdmissionRule {
  /** Stable kebab-case id, e.g. "no-external-net", "build-must-pass". */
  ruleId: string;
  description: string;
  evaluator: AdmissionEvaluator;
}

// ── Main contracts ───────────────────────────────────────────────────────────

/**
 * Declares the conditions under which evidence rows are admitted as
 * claim-eligible. One contract per workload × driver × runtime combination.
 */
export interface EvidenceAdmissionContract {
  workloadId: string;
  driverName: string;
  runtimeSetting: RuntimeSetting;
  /** e.g. "evidence-admission/v1" */
  schemaVersion: string;
  replayPolicy: ReplayPolicy;
  admissionRules: AdmissionRule[];
  redactionPolicy: RedactionPolicy;
}

/**
 * One evidence row after the admission gate has been applied.
 * `type === "admitted"` rows may appear in public claims.
 */
export interface EvidenceRow {
  rowId: string;
  type: EvidenceRowType;
  /** Opaque ref — content hash, URI, or relative path. */
  evidenceRef: string;
  /** ms epoch; present only for admitted rows. */
  admittedAt?: number;
  /** Present only when `type !== "admitted"`. */
  rejectionReason?: string;
}

// ── Zod schemas (wire-safe — no function fields) ─────────────────────────────

export const EvidenceRowSchema = z.object({
  rowId: z.string().min(1),
  type: EvidenceRowTypeSchema,
  evidenceRef: z.string().min(1),
  admittedAt: z.number().int().positive().optional(),
  rejectionReason: z.string().optional(),
});

/**
 * Wire-safe contract schema. `admissionRules` omits the `evaluator` field —
 * callers must re-attach evaluators from their registry after deserialization.
 */
export const EvidenceAdmissionContractSchema = z.object({
  workloadId: z.string().min(1),
  driverName: z.string().min(1),
  runtimeSetting: RuntimeSettingSchema,
  schemaVersion: z.string().min(1),
  replayPolicy: ReplayPolicySchema,
  admissionRules: z.array(z.object({
    ruleId: z.string().min(1),
    description: z.string(),
  })),
  redactionPolicy: RedactionPolicySchema,
});
