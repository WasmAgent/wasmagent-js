/**
 * BuildPassesVerifier — verifies that a build command completed successfully.
 *
 * Reads build results via an injected callback so this package stays
 * decoupled from bscode's concrete implementation. The bscode adapter
 * wraps runCommand() results into the BuildResult shape.
 *
 * Judgment rules:
 *   exitCode === 0              → ok: true
 *   exitCode !== 0              → ok: false, hint: summarized stderr
 *   status "running" | "unknown" → ok: false ("build not yet complete")
 *                                  NEVER defaults to pass
 */

import { summarizeToolOutput } from "../ToolOutputSummarizer.js";
import type { Criterion, CriterionVerdict, Verifier, WorkspaceReader } from "./types.js";

export type BuildStatus = "success" | "failure" | "running" | "unknown";

export interface BuildResult {
  status: BuildStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Callback injected by the bscode adapter to fetch a build result by session. */
export type BuildResultReader = (sessionId: string) => Promise<BuildResult | null>;

export interface BuildPassesVerifierOptions {
  /**
   * Fetch a build result by session ID.
   * The session ID is read from `criterion.arg` (expected: string).
   * If null is returned, the verifier treats it as "unknown" (not pass).
   */
  getBuildResult: BuildResultReader;
}

export class BuildPassesVerifier implements Verifier {
  readonly methods = ["build_passes"] as const;
  readonly #getBuildResult: BuildResultReader;

  constructor(opts: BuildPassesVerifierOptions) {
    this.#getBuildResult = opts.getBuildResult;
  }

  async verify(criterion: Criterion, _ws: WorkspaceReader): Promise<CriterionVerdict> {
    const id = criterion.id;
    const fail = (hint: string): CriterionVerdict => ({ ok: false, criterionId: id, hint });

    const sessionId = typeof criterion.arg === "string" ? criterion.arg : null;
    if (!sessionId) {
      return fail("build_passes criterion requires criterion.arg to be the session ID string");
    }

    let result: BuildResult | null;
    try {
      result = await this.#getBuildResult(sessionId);
    } catch (e) {
      return fail(`getBuildResult threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (result === null) {
      return fail(`no build result found for session ${sessionId}`);
    }

    if (result.status === "running" || result.status === "unknown") {
      return fail(`build not yet complete (status: ${result.status})`);
    }

    if (result.exitCode === 0) {
      return { ok: true, criterionId: id };
    }

    const hint = summarizeToolOutput(
      result.stderr || result.stdout || "build failed with no output"
    );
    return fail(hint);
  }
}
