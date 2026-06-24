/**
 * RepairPlanner — drives a violation list through repair rounds until
 * the artifact passes, the round budget runs out, or every strategy
 * has been tried.
 *
 * # Loop shape
 *
 *   while violations remain and round < max_rounds:
 *     round += 1
 *     for each violation (ordered by priority):
 *       pick strategy from ir.repair.strategy (with escalation history)
 *       apply strategy → new artifact
 *       persist artifact (caller-supplied workspace writer)
 *       re-verify → updated violations
 *       break inner loop after the first strategy that changes the artifact
 *     if no progress this round → break (saves rounds)
 *
 * # Escalation
 *
 * If a cheap strategy (`patch` / `insert_section`) doesn't clear a
 * violation in its round, the planner upgrades that violation to
 * `regenerate_region` for the next round. The escalation history is
 * per-violation, not global — different violations can be at different
 * strategy levels in the same run.
 *
 * Escalation order (planner internal):
 *   patch → regenerate_region → full
 *   insert_section → regenerate_region → full
 *
 * # What the planner does NOT do (yet)
 *
 *  - Cross-violation batching: each round targets one violation. A
 *    Phase-1 optimisation can batch when multiple violations share
 *    `target_region`.
 *  - Soft-violation budgeting: hard violations drive the loop; soft
 *    violations are recorded by the verifier but not repaired by
 *    default. Pass `repair_soft: true` to include them.
 */

import type { ConstraintIR, TaskSpec } from "../ir/ConstraintIR.js";
import type { ComplianceVerifier } from "../verifier/ComplianceVerifier.js";
import type { ConstraintViolation } from "../verifier/violation.js";
import type { RepairLLM } from "./RepairLLM.js";
import type { RepairTraceEntry } from "./RepairTrace.js";
import { InsertSectionStrategy } from "./strategies/insertSection.js";
import { PatchStrategy } from "./strategies/patch.js";
import { RegenerateRegionStrategy } from "./strategies/regenerateRegion.js";
import type { RepairStrategy } from "./strategies/types.js";

/**
 * Writer the planner uses to persist a repaired artifact back to the
 * workspace before the verifier re-reads it. Mirrors the read side of
 * `@wasmagent/core` `WorkspaceReader` — we don't reuse the reader
 * type to avoid coupling the planner to read APIs it doesn't need.
 */
export interface WorkspaceWriter {
  writeFile(path: string, body: string): Promise<void>;
}

export interface RepairPlannerOptions {
  verifier: ComplianceVerifier;
  writer: WorkspaceWriter;
  /** LLM used by `regenerate_region`. Optional for deterministic tests. */
  llm?: RepairLLM;
  /**
   * Override the default strategy registry. Tests can inject fakes here
   * to assert which strategy was selected without running the real one.
   */
  strategies?: RepairStrategy[];
  /**
   * Hard ceiling on repair rounds. Defaults to
   * `TaskSpec.repair.max_rounds` or 3 if neither is set.
   */
  max_rounds?: number;
  /**
   * If true, the planner also tries to repair `soft` violations after
   * all `hard` violations are clear. Default false.
   */
  repair_soft?: boolean;
}

export interface RepairResult {
  /** Final artifact text after all repair rounds. */
  artifact: string;
  /** Per-round trace; consumed by ComplianceEvalRecord.repair_trace. */
  trace: RepairTraceEntry[];
  /**
   * Initial violation list — kept verbatim so the eval record can
   * report "what was wrong before repair" separately from the trace.
   */
  initial_violations: ConstraintViolation[];
  /** Hard violations still failing at the end of the run. */
  remaining_hard_violations: ConstraintViolation[];
  /** True iff zero hard violations remain. */
  final_pass: boolean;
}

export class RepairPlanner {
  readonly #verifier: ComplianceVerifier;
  readonly #writer: WorkspaceWriter;
  readonly #llm?: RepairLLM;
  readonly #strategies: Map<string, RepairStrategy>;
  readonly #max_rounds?: number;
  readonly #repair_soft: boolean;

  constructor(opts: RepairPlannerOptions) {
    this.#verifier = opts.verifier;
    this.#writer = opts.writer;
    if (opts.llm !== undefined) this.#llm = opts.llm;
    const defaults: RepairStrategy[] = [
      new PatchStrategy(),
      new InsertSectionStrategy(),
      new RegenerateRegionStrategy(),
    ];
    const list = opts.strategies ?? defaults;
    this.#strategies = new Map(list.map((s) => [s.kind, s]));
    if (opts.max_rounds !== undefined) this.#max_rounds = opts.max_rounds;
    this.#repair_soft = opts.repair_soft ?? false;
  }

  /**
   * Run the repair loop. Returns the final artifact, the per-round
   * trace, and the remaining hard violations.
   *
   * Preconditions: the caller has already produced `initial_artifact`
   * and has the corresponding `initial_violations` list from a prior
   * `ComplianceVerifier.verify(spec)` call.
   */
  async repair(opts: {
    spec: TaskSpec;
    /** File path the verifier reads + the writer writes. */
    artifact_path: string;
    initial_artifact: string;
    initial_violations: ConstraintViolation[];
  }): Promise<RepairResult> {
    const max_rounds = this.#max_rounds ?? opts.spec.repair?.max_rounds ?? 3;

    let artifact = opts.initial_artifact;
    let violations = opts.initial_violations;
    const trace: RepairTraceEntry[] = [];
    // Per-violation escalation history. Key = constraint_id.
    const tried = new Map<string, Set<RepairStrategy["kind"]>>();

    for (let round = 1; round <= max_rounds; round++) {
      // Pick the next hard (or soft, if enabled) violation to address.
      const targets = this.#prioritise(violations);
      const target = targets[0];
      if (!target) break;

      const ir = opts.spec.constraints.find((c) => c.id === target.constraint_id);
      if (!ir) break; // shouldn't happen; defensive.

      const triedSet = tried.get(target.constraint_id) ?? new Set();
      const strategyKind = this.#pickStrategy(ir, triedSet);
      if (!strategyKind) {
        // Out of strategies for this violation. Skip to next loop iter,
        // which will pick a different violation if one exists.
        triedSet.add("full"); // mark fully exhausted
        tried.set(target.constraint_id, triedSet);
        violations = violations.filter((v) => v.constraint_id !== target.constraint_id);
        continue;
      }
      triedSet.add(strategyKind);
      tried.set(target.constraint_id, triedSet);

      const strategy = this.#strategies.get(strategyKind);
      if (!strategy) {
        // Strategy not registered — bail rather than loop forever.
        break;
      }

      // Snapshot pre-round state so we can roll back if this round
      // accidentally re-breaks a previously-passing constraint
      // (the "repair regression" failure mode — 6/23 PCL failures
      // in the 2026-06-24 baseline sweep). Cheap: the artifact is
      // a string and the failing-id set is at most #constraints.
      const preArtifact = artifact;
      const preFailing = new Set(violations.map((v) => v.constraint_id));

      const t0 = performance.now();
      const result = await strategy.apply({
        artifact,
        violation: target,
        ir,
        all_violations: violations,
        ...(this.#llm ? { llm: this.#llm } : {}),
      });
      const latency_ms = Math.round(performance.now() - t0);

      let ok = false;
      let rolled_back = false;
      let remaining_violation_ids: string[] | undefined;

      if (result.artifact === null || result.artifact === preArtifact) {
        // Strategy didn't change anything. Record the round, escalate
        // next iteration (the triedSet already has this strategy
        // marked).
        ok = false;
        remaining_violation_ids = violations.map((v) => v.constraint_id);
      } else {
        // Tentatively accept the new artifact, re-verify, then check
        // for regressions before committing.
        await this.#writer.writeFile(opts.artifact_path, result.artifact);
        const reverify = await this.#verifier.verify(opts.spec);
        const newFailing = new Set(reverify.violations.map((v) => v.constraint_id));

        // Regression = a constraint that was passing pre-round is now
        // failing. (A constraint that was failing both before and
        // after is not a regression — that's the normal "strategy
        // didn't clear it" case.)
        const regressed: string[] = [];
        for (const cid of newFailing) {
          if (!preFailing.has(cid)) regressed.push(cid);
        }

        if (regressed.length > 0) {
          // Don't commit. Roll back the artifact and treat the round
          // as failed; the planner will escalate to a different
          // strategy next iteration (this strategy is now in
          // triedSet for the target).
          await this.#writer.writeFile(opts.artifact_path, preArtifact);
          rolled_back = true;
          ok = false;
          // Keep `violations` at its pre-round value — we discarded
          // the proposed artifact, so the world looks the same as
          // before this round started.
          remaining_violation_ids = violations.map((v) => v.constraint_id);
        } else {
          // No regression — commit.
          artifact = result.artifact;
          violations = reverify.violations;
          ok = !violations.some((v) => v.constraint_id === target.constraint_id);
          remaining_violation_ids = violations.map((v) => v.constraint_id);
        }
      }

      const entry: RepairTraceEntry = {
        round,
        violation_ids: [target.constraint_id],
        strategy: strategyKind,
        ok,
        latency_ms,
      };
      if (rolled_back) {
        // Surface the rollback in the trace so downstream consumers
        // (eval reports, failure taxonomy) can count it. Recorded as
        // a flag rather than a separate strategy so the trace-entry
        // shape stays stable for existing consumers.
        entry.rolled_back = true;
      }
      if (ir.repair?.target_region !== undefined) {
        entry.target_region = ir.repair.target_region;
      }
      if (remaining_violation_ids !== undefined) {
        entry.remaining_violation_ids = remaining_violation_ids;
      }
      if (result.usage) {
        entry.token_cost = {
          ...(result.usage.prompt_tokens !== undefined
            ? { prompt: result.usage.prompt_tokens }
            : {}),
          ...(result.usage.completion_tokens !== undefined
            ? { generation: result.usage.completion_tokens }
            : {}),
        };
      }
      trace.push(entry);

      if (violations.length === 0) break;
    }

    const remaining_hard = violations.filter((v) => v.level === "hard");
    return {
      artifact,
      trace,
      initial_violations: opts.initial_violations,
      remaining_hard_violations: remaining_hard,
      final_pass: remaining_hard.length === 0,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Order violations by `(level=hard before soft, then constraint
   * priority descending)`. Returns hard violations first; if
   * `repair_soft` is on, soft violations follow once all hard are clear.
   */
  #prioritise(violations: ConstraintViolation[]): ConstraintViolation[] {
    const hard = violations.filter((v) => v.level === "hard");
    if (hard.length > 0) {
      return [...hard];
    }
    if (this.#repair_soft) {
      return [...violations.filter((v) => v.level === "soft")];
    }
    return [];
  }

  /**
   * Decide which strategy to try next for a constraint. Honour the IR's
   * declared strategy first; on retry, escalate.
   */
  #pickStrategy(
    ir: ConstraintIR,
    tried: Set<RepairStrategy["kind"]>
  ): RepairStrategy["kind"] | null {
    const declared = ir.repair?.strategy;
    if (declared && !tried.has(declared)) return declared;

    // Escalation path. We try strategies in order of increasing cost.
    const ladder: RepairStrategy["kind"][] = [
      "patch",
      "insert_section",
      "regenerate_region",
      "full",
    ];
    for (const k of ladder) {
      if (!tried.has(k) && this.#strategies.has(k)) return k;
    }
    return null;
  }
}
