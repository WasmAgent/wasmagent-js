/**
 * VerificationPipeline — runs N criteria, dispatches each to the right
 * verifier, aggregates verdicts into a single Goal-compatible value.
 *
 * The pipeline is the bridge between the **declarative** layer
 * (Criterion JSON, easy for an LLM to synthesize) and the
 * **operational** layer (Goal.verify, expects `() => Promise<{ok|hint}>`).
 *
 * # Verifier dispatch
 *
 * Each registered Verifier declares the `verify_method` strings it
 * handles. The pipeline keeps a method→verifier map and routes
 * Criterion-by-Criterion. Unknown methods produce a fail verdict (with
 * a hint that names the missing method) instead of throwing — this
 * lets the LLM synthesizer experiment with new method names without
 * breaking the loop; the resulting hint round-trips back as feedback.
 *
 * # Aggregation
 *
 * The pipeline reports `ok: true` only when **every** criterion passes.
 * Any single failure surfaces as `ok: false` with a hint that lists the
 * failing criteria's ids + their individual hints. This keeps GoalAgent
 * able to feed actionable guidance into the next iteration.
 *
 * # Wiring B2/C3 objective signals (bscode adapter pattern)
 *
 * `BuildPassesVerifier` and `VisualAssertVerifier` integrate with the pipeline
 * via dependency-injected callbacks — the pipeline stays decoupled from
 * bscode's concrete implementation.
 *
 * ```ts
 * import { BuildPassesVerifier, VisualAssertVerifier, VerificationPipeline } from "@wasmagent/core";
 *
 * // Adapter: reads build result from bscode's runCommand() return value.
 * // Call this after RemoteSandboxKernel.runCommand("npm run build") completes.
 * function makeBscodeAdapter(sessionId: string, exitCode: number, stderr: string) {
 *   return {
 *     getBuildResult: async (_sid: string) => ({
 *       status: exitCode === 0 ? "success" as const : "failure" as const,
 *       exitCode,
 *       stdout: "",
 *       stderr,
 *     }),
 *   };
 * }
 *
 * // Adapter: reads visual assertion result from bscode's visual verifier.
 * function makeVisualAdapter(verdict: "pass" | "fail", reason?: string) {
 *   return {
 *     getVisualResult: async (_sid: string) => ({ verdict, reason }),
 *   };
 * }
 *
 * const sessionId = "job-abc-b0";
 * const ws = { readFile: ..., fileExists: ..., fileSize: ... };
 *
 * const pipeline = new VerificationPipeline({
 *   ws,
 *   verifiers: [
 *     new BuildPassesVerifier(makeBscodeAdapter(sessionId, 0, "")),
 *     new VisualAssertVerifier(makeVisualAdapter("pass")),
 *   ],
 * });
 *
 * // Criteria reference the session ID via criterion.arg so each rollout
 * // branch has its own isolated result — no cross-branch state leakage.
 * const criteria = [
 *   { id: "build", description: "npm build exits 0", verify_method: "build_passes", arg: sessionId },
 *   { id: "ui",    description: "UI matches baseline", verify_method: "visual_assert", arg: sessionId },
 * ];
 *
 * const result = await pipeline.run(criteria);
 * // result.ok === true only when build AND visual assertion both pass.
 *
 * // Drop directly into GoalAgent:
 * const goalVerify = pipeline.asGoalVerify(criteria);
 * ```
 */

import type { Criterion, CriterionVerdict, Verifier, WorkspaceReader } from "./types.js";

export interface VerificationResult {
  ok: boolean;
  /** Verdict per criterion in input order — useful for UI / logging. */
  verdicts: CriterionVerdict[];
  /** Compact aggregated hint (≤ ~600 chars), suitable for an LLM prompt. */
  hint?: string;
}

export class VerificationPipeline {
  readonly #verifiers = new Map<string, Verifier>();
  readonly #ws: WorkspaceReader;

  constructor(opts: { ws: WorkspaceReader; verifiers: Verifier[] }) {
    this.#ws = opts.ws;
    for (const v of opts.verifiers) this.register(v);
  }

  register(verifier: Verifier): void {
    for (const m of verifier.methods) {
      // Last-registered wins. Loud here would be safer but the use case
      // (test fakes overriding real verifiers) is common enough that we
      // accept silent override; tests should assert the final mapping
      // rather than rely on registration order.
      this.#verifiers.set(m, verifier);
    }
  }

  /** Returns the methods the pipeline currently handles. */
  knownMethods(): string[] {
    return [...this.#verifiers.keys()].sort();
  }

  /**
   * Run all criteria and aggregate. Verifiers that throw are caught
   * here and turned into `{ok:false, hint:"verifier threw: …"}` —
   * exceptions are infrastructure failures, not goal-state failures,
   * but the pipeline still has to make progress so the loop can
   * surface the error to the operator.
   */
  async run(criteria: Criterion[]): Promise<VerificationResult> {
    const verdicts: CriterionVerdict[] = [];
    for (const c of criteria) {
      const verifier = this.#verifiers.get(c.verify_method);
      if (!verifier) {
        verdicts.push({
          ok: false,
          criterionId: c.id,
          hint: `no verifier registered for verify_method=${c.verify_method}; known methods: ${this.knownMethods().join(", ")}`,
        });
        continue;
      }
      try {
        verdicts.push(await verifier.verify(c, this.#ws));
      } catch (e) {
        verdicts.push({
          ok: false,
          criterionId: c.id,
          hint: `verifier for ${c.verify_method} threw: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    const failing = verdicts.filter((v): v is Extract<CriterionVerdict, { ok: false }> => !v.ok);
    if (failing.length === 0) {
      return { ok: true, verdicts };
    }
    // Compact hint: list each failing criterion as "id: hint" on its own
    // line. Hard cap at ~600 chars total — beyond that the next
    // iteration's prompt fills with stale failures and the LLM ignores
    // them. If truncated, append a count of suppressed entries so the
    // operator sees the total.
    const lines = failing.map((v) => `- ${v.criterionId}: ${v.hint}`);
    let combined = lines.join("\n");
    const HINT_CAP = 600;
    if (combined.length > HINT_CAP) {
      let kept = 0;
      let acc = "";
      for (const line of lines) {
        if (acc.length + line.length + 1 > HINT_CAP) break;
        acc += (kept === 0 ? "" : "\n") + line;
        kept++;
      }
      const omitted = failing.length - kept;
      combined = `${acc}\n…and ${omitted} more failure(s) omitted`;
    }
    return { ok: false, verdicts, hint: combined };
  }

  /**
   * Adapter — return a function shaped like `Goal.verify` so a
   * VerificationPipeline can drop directly into a `GoalAgent`. The
   * verdicts stay accessible via the captured `lastResult` variable
   * the caller passes in.
   */
  asGoalVerify(criteria: Criterion[]): () => Promise<{ ok: true } | { ok: false; hint?: string }> {
    return async () => {
      const result = await this.run(criteria);
      if (result.ok) return { ok: true };
      return { ok: false, ...(result.hint ? { hint: result.hint } : {}) };
    };
  }
}
