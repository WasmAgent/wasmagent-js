/**
 * Verifier — declarative, mechanically-checked criteria for agent goals.
 *
 * `GoalAgent` (and the higher-level `GoalDirectedAgent`) end each
 * iteration by asking "is the world now in the state we wanted?". This
 * file defines the **shared shape** for that check so the loop layer
 * doesn't have to know whether a verifier reads a file, runs a
 * subprocess, or asks a separate LLM to judge.
 *
 * # Hierarchy
 *
 *   Criterion            — declarative spec ("≥1500 chars in foo.md")
 *   Verifier             — function that turns a Criterion into a verdict
 *   VerificationPipeline — runs N criteria, aggregates verdicts, returns
 *                          a single Goal-compatible {ok | hint} value
 *
 * # Why two layers (criteria + verifier)
 *
 * A `Criterion` is **data** — JSON-serializable, easy to log, easy for an
 * LLM to synthesize from a user goal (see `CriteriaSynthesizer`). A
 * `Verifier` is **code** — it owns the I/O (fs reads, model calls). The
 * split lets the same criterion be evaluated by different verifier
 * implementations (e.g. an in-memory test fake vs the real fs reader)
 * and lets the criteria themselves cross process boundaries.
 *
 * # Determinism preference
 *
 * Built-in `verify_method` values are deterministic — they read the
 * artifact and produce a verdict from observable facts. `llm_judge` is
 * the only non-deterministic kind, and it's intentionally walled behind
 * `LLMJudgeVerifier` with adversarial defaults (default-fail, k>=3
 * voting, low temperature). See [[loop-engineering-deliverables-2026-06-15]]
 * for why deterministic verify is preferred — when an LLM grades its own
 * work, you've re-introduced the reward-hacking loop the verify step
 * was meant to close.
 *
 * # Open enum
 *
 * `verify_method` is an open string union: built-ins are listed for
 * autocomplete, but applications can register custom kinds via
 * `VerificationPipeline.register()`. This keeps the protocol product-
 * agnostic — bscode's "build_passes" or a CI's "lighthouse_score_min"
 * verifier registers without touching WasmAgent core.
 */

/**
 * A single declarative success criterion the agent must satisfy.
 *
 * `id` and `description` are human-readable + appear in retry hints.
 * `verify_method` selects which `Verifier` evaluates it.
 * `arg` is method-specific (number for `_min`, string for `_contains`,
 * object for `llm_judge`, undefined for argument-less methods like
 * `file_exists`). Open type: a custom verifier registered at runtime
 * can use any JSON-shaped arg.
 */
export interface Criterion {
  id: string;
  description: string;
  verify_method:
    | "file_exists"
    | "file_size_min"
    | "file_size_max"
    | "file_contains"
    | "file_matches"
    | "headings_count_min"
    | "word_count_min"
    | "llm_judge"
    | (string & {});
  /**
   * Method-specific argument. Type is intentionally permissive — each
   * verifier validates its own arg shape and throws a useful error
   * (caught + reported as a verdict failure) if it doesn't fit.
   */
  arg?: unknown;
  /**
   * Optional file path the criterion targets. For file-* methods this
   * is required; for `llm_judge` it tells the verifier which artifact
   * to read into the judge's context. May be omitted for criteria that
   * apply to the whole workspace or to a non-file artifact.
   */
  path?: string;
}

/**
 * Verdict for one criterion. Mirrors `Goal.verify`'s return shape so
 * verifiers can be composed with raw GoalAgent verify functions.
 */
export type CriterionVerdict =
  | { ok: true; criterionId: string }
  | { ok: false; criterionId: string; hint: string };

/**
 * Read access to the workspace the agent has been operating in.
 *
 * Verifiers read artifacts through this interface so they can be unit-
 * tested with an in-memory fake. The same shape works for Node fs, a
 * Cloudflare KV/R2 backed worker, or a remote ssh sandbox.
 */
export interface WorkspaceReader {
  /** Read a file as UTF-8 text. Throws if the file does not exist. */
  readFile(path: string): Promise<string>;
  /** Returns true iff the file exists at the given path. */
  fileExists(path: string): Promise<boolean>;
  /** Byte size of the file. Throws if the file does not exist. */
  fileSize(path: string): Promise<number>;
}

/**
 * Strategy that turns a single Criterion into a CriterionVerdict.
 *
 * Implementations are async because real verifiers do I/O (fs, model
 * call, subprocess). Pure verifiers can wrap the result in
 * `Promise.resolve`. A verifier that throws will be caught by the
 * pipeline and rendered as a `{ok:false, hint:"verifier threw: …"}`
 * verdict — exceptions are infrastructure failures, not goal-state
 * failures, but the pipeline still has to make progress.
 */
export interface Verifier {
  /** The verify_method values this verifier handles. */
  readonly methods: readonly string[];
  verify(criterion: Criterion, ws: WorkspaceReader): Promise<CriterionVerdict>;
}

// ── Built-in deterministic verifiers ────────────────────────────────────────

const numberArg = (criterion: Criterion): number => {
  const n = typeof criterion.arg === "number" ? criterion.arg : Number(criterion.arg);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Criterion ${criterion.id}: ${criterion.verify_method} expects a numeric arg, got ${JSON.stringify(criterion.arg)}`
    );
  }
  return n;
};

const stringArg = (criterion: Criterion): string => {
  if (typeof criterion.arg !== "string") {
    throw new Error(
      `Criterion ${criterion.id}: ${criterion.verify_method} expects a string arg, got ${JSON.stringify(criterion.arg)}`
    );
  }
  return criterion.arg;
};

const requirePath = (criterion: Criterion): string => {
  if (!criterion.path) {
    throw new Error(`Criterion ${criterion.id}: ${criterion.verify_method} requires a path`);
  }
  return criterion.path;
};

/**
 * Verifier covering the deterministic built-ins.
 *
 * One class instead of seven keeps `methods` co-located and avoids
 * dispatch boilerplate at registration time. Each method's check is
 * straightforward; the interesting logic lives in the LLM-judge.
 */
export class DeterministicVerifier implements Verifier {
  readonly methods = [
    "file_exists",
    "file_size_min",
    "file_size_max",
    "file_contains",
    "file_matches",
    "headings_count_min",
    "word_count_min",
  ] as const;

  async verify(criterion: Criterion, ws: WorkspaceReader): Promise<CriterionVerdict> {
    const id = criterion.id;
    const fail = (hint: string): CriterionVerdict => ({ ok: false, criterionId: id, hint });
    const pass = (): CriterionVerdict => ({ ok: true, criterionId: id });

    switch (criterion.verify_method) {
      case "file_exists": {
        const path = requirePath(criterion);
        return (await ws.fileExists(path)) ? pass() : fail(`file ${path} does not exist`);
      }
      case "file_size_min": {
        const path = requirePath(criterion);
        const min = numberArg(criterion);
        if (!(await ws.fileExists(path))) return fail(`file ${path} does not exist`);
        const size = await ws.fileSize(path);
        return size >= min
          ? pass()
          : fail(`file ${path} is ${size} bytes; criterion requires ≥${min}`);
      }
      case "file_size_max": {
        const path = requirePath(criterion);
        const max = numberArg(criterion);
        if (!(await ws.fileExists(path))) return fail(`file ${path} does not exist`);
        const size = await ws.fileSize(path);
        return size <= max
          ? pass()
          : fail(`file ${path} is ${size} bytes; criterion requires ≤${max}`);
      }
      case "file_contains": {
        const path = requirePath(criterion);
        const needle = stringArg(criterion);
        if (!(await ws.fileExists(path))) return fail(`file ${path} does not exist`);
        const body = await ws.readFile(path);
        return body.includes(needle)
          ? pass()
          : fail(`file ${path} does not contain ${JSON.stringify(needle.slice(0, 60))}`);
      }
      case "file_matches": {
        const path = requirePath(criterion);
        const pattern = stringArg(criterion);
        if (!(await ws.fileExists(path))) return fail(`file ${path} does not exist`);
        const body = await ws.readFile(path);
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (e) {
          return fail(
            `pattern ${JSON.stringify(pattern)} is not a valid RegExp: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        return re.test(body) ? pass() : fail(`file ${path} does not match /${pattern}/`);
      }
      case "headings_count_min": {
        const path = requirePath(criterion);
        const min = numberArg(criterion);
        if (!(await ws.fileExists(path))) return fail(`file ${path} does not exist`);
        const body = await ws.readFile(path);
        // Match Markdown headings — # through ###### at start of a line.
        // Avoids matching `#tag` inside prose by requiring whitespace
        // (or end-of-line) immediately after the # run.
        const headings = body.match(/^#{1,6}(?:\s|$)/gm) ?? [];
        return headings.length >= min
          ? pass()
          : fail(
              `file ${path} has ${headings.length} markdown heading(s); criterion requires ≥${min}`
            );
      }
      case "word_count_min": {
        const path = requirePath(criterion);
        const min = numberArg(criterion);
        if (!(await ws.fileExists(path))) return fail(`file ${path} does not exist`);
        const body = await ws.readFile(path);
        // Word count covering both Latin and CJK — Latin words are
        // whitespace-separated tokens; each CJK ideograph is itself
        // one "word" for length-budget purposes (matches user intent
        // when they say "≥1500 字"). Arabic/Hebrew/Devanagari fall
        // under the Latin branch via Unicode \p{L}\p{N}.
        const cjk = body.match(/[一-鿿㐀-䶿]/gu) ?? [];
        const latinWords = body
          .replace(/[一-鿿㐀-䶿]/gu, " ")
          .split(/\s+/)
          .filter((w) => /[\p{L}\p{N}]/u.test(w));
        const total = cjk.length + latinWords.length;
        return total >= min
          ? pass()
          : fail(`file ${path} has ${total} word(s)/字; criterion requires ≥${min}`);
      }
      default:
        return fail(
          `verify_method ${criterion.verify_method} is not handled by DeterministicVerifier`
        );
    }
  }
}
