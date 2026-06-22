/**
 * VisualAssertVerifier — verifies that a visual assertion passed.
 *
 * Reads visual assertion results via an injected callback, parallel
 * to BuildPassesVerifier. The bscode adapter wraps screenshot/pixel-diff
 * results into the VisualResult shape.
 *
 * Judgment rules:
 *   verdict "pass"              → ok: true
 *   verdict "fail"              → ok: false, hint: reason
 *   verdict "pending" | "unknown" → ok: false ("visual assertion not yet complete")
 *                                    NEVER defaults to pass
 */

import type { Criterion, CriterionVerdict, Verifier, WorkspaceReader } from "./types.js";

export type VisualVerdict = "pass" | "fail" | "pending" | "unknown";

export interface VisualResult {
  verdict: VisualVerdict;
  reason?: string;
}

export type VisualResultReader = (sessionId: string) => Promise<VisualResult | null>;

export interface VisualAssertVerifierOptions {
  /**
   * Fetch a visual assertion result by session ID.
   * Session ID is read from `criterion.arg` (expected: string).
   */
  getVisualResult: VisualResultReader;
}

export class VisualAssertVerifier implements Verifier {
  readonly methods = ["visual_assert"] as const;
  readonly #getVisualResult: VisualResultReader;

  constructor(opts: VisualAssertVerifierOptions) {
    this.#getVisualResult = opts.getVisualResult;
  }

  async verify(criterion: Criterion, _ws: WorkspaceReader): Promise<CriterionVerdict> {
    const id = criterion.id;
    const fail = (hint: string): CriterionVerdict => ({ ok: false, criterionId: id, hint });

    const sessionId = typeof criterion.arg === "string" ? criterion.arg : null;
    if (!sessionId) {
      return fail("visual_assert criterion requires criterion.arg to be the session ID string");
    }

    let result: VisualResult | null;
    try {
      result = await this.#getVisualResult(sessionId);
    } catch (e) {
      return fail(`getVisualResult threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (result === null) {
      return fail(`no visual result found for session ${sessionId}`);
    }

    if (result.verdict === "pending" || result.verdict === "unknown") {
      return fail(`visual assertion not yet complete (verdict: ${result.verdict})`);
    }

    if (result.verdict === "pass") {
      return { ok: true, criterionId: id };
    }

    return fail(result.reason ?? "visual assertion failed");
  }
}
