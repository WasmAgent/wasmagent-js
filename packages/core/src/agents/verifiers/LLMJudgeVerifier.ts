/**
 * LLMJudgeVerifier — adversarial LLM-based criterion check.
 *
 * Use ONLY for criteria a deterministic verifier can't express: subjective
 * quality, "does this prose actually cover topic X", "is the code idiomatic".
 * For everything mechanical, prefer `DeterministicVerifier`. See
 * [[loop-engineering-deliverables-2026-06-15]] and the GoalAgent docstring
 * for why LLM-as-judge is the reward-hacking risk point.
 *
 * # Defenses against reward hacking
 *
 * 1. **Default-fail.** The judge prompt instructs the model to return
 *    `pass: false` whenever it is uncertain or the artifact is missing
 *    important content. The schema also defaults to `false` if the
 *    model's reply is unparseable.
 * 2. **K-of-N voting.** By default we run `samples = 3` independent
 *    judge calls and require **all** to pass — any single dissent
 *    fails the criterion. This makes a single hallucinated
 *    `pass: true` insufficient. (Adjustable via `samples` /
 *    `requirePassMajority`.)
 * 3. **Low temperature.** Each call uses `temperature = 0.1`; the small
 *    non-zero value prevents identical caching when the same model is
 *    queried back-to-back.
 * 4. **Strict structured output.** The reply must be JSON
 *    `{pass: boolean, reasoning: string}`. Anything else is treated as
 *    `pass: false` with a `judge_unparseable` hint.
 * 5. **Independent judge model.** The verifier accepts a `model`
 *    distinct from the executing model — operators can use a stronger
 *    or differently-aligned grader, reducing self-graded inflation.
 */

import type { Model } from "../../models/types.js";
import type { Criterion, CriterionVerdict, Verifier, WorkspaceReader } from "./types.js";

export interface LLMJudgeVerifierOptions {
  /** The model used to judge criteria. Recommended: separate from the executing model. */
  model: Model;
  /**
   * How many independent judge calls per criterion. Default 3. Higher
   * values reduce variance but cost linearly more tokens.
   */
  samples?: number;
  /**
   * If `true`, the criterion passes when a strict majority of samples
   * vote pass. If `false` (the default and recommended), ALL samples
   * must vote pass — any dissent fails. The conservative default
   * matches the "default-fail" stance.
   */
  requirePassMajority?: boolean;
  /**
   * If a criterion has a `path`, the judge sees the file contents
   * (truncated to this many characters). Default 8000.
   */
  maxArtifactChars?: number;
  /**
   * Sampling temperature for each judge call. Default 0.1.
   */
  temperature?: number;
  /**
   * Token cap per judge call. Default 400. Reasoning is bounded —
   * judges do not need long context to refuse with cause.
   */
  maxTokens?: number;
}

/**
 * The exact instruction string sent as the system prompt for every
 * judge call. Exported so tests can lock down the wording — any drift
 * here changes the verifier's bias and we want loud test failures
 * before that ships.
 */
export const LLM_JUDGE_SYSTEM_PROMPT = `You are an adversarial reviewer judging whether an artifact satisfies a single criterion.

Your job is to REFUTE rather than confirm. Default to pass: false in any of these cases:
  - the artifact is missing or empty
  - the artifact does not directly evidence the criterion
  - you are uncertain or the criterion is ambiguous given the artifact

Only return pass: true when the artifact contains specific, concrete evidence that meets the criterion.

Reply with strict JSON, one line, no prose, no markdown fencing:
{"pass": <boolean>, "reasoning": "<one short sentence>"}

Do NOT echo the criterion. Do NOT speculate about what the author probably meant. Judge what is actually present in the artifact.`;

interface JudgeReply {
  pass: boolean;
  reasoning: string;
}

function parseJudgeReply(text: string): JudgeReply | null {
  // Strip code fences the model may add despite the instruction.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  // Find the first balanced JSON object; some models trail with prose.
  const match = stripped.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { pass?: unknown; reasoning?: unknown };
    if (typeof parsed.pass !== "boolean") return null;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    return { pass: parsed.pass, reasoning };
  } catch {
    return null;
  }
}

/**
 * Run one judge call. Returns null if the model output is unparseable,
 * which the caller treats as a `pass: false` vote.
 */
async function singleJudgeCall(
  model: Model,
  criterion: Criterion,
  artifact: string | null,
  opts: { temperature: number; maxTokens: number }
): Promise<JudgeReply | null> {
  const userMessage = [
    `Criterion id: ${criterion.id}`,
    `Criterion description: ${criterion.description}`,
    artifact === null
      ? "Artifact: <none read — criterion has no `path` or file is missing>"
      : `Artifact (${artifact.length} chars):\n---\n${artifact}\n---`,
  ].join("\n");

  let buffer = "";
  for await (const ev of model.generate(
    [
      { role: "system", content: LLM_JUDGE_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    {
      stream: true,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    }
  )) {
    if (ev.type === "text_delta" && ev.delta) buffer += ev.delta;
  }
  return parseJudgeReply(buffer);
}

export class LLMJudgeVerifier implements Verifier {
  readonly methods = ["llm_judge"] as const;
  readonly #model: Model;
  readonly #samples: number;
  readonly #requirePassMajority: boolean;
  readonly #maxArtifactChars: number;
  readonly #temperature: number;
  readonly #maxTokens: number;

  constructor(opts: LLMJudgeVerifierOptions) {
    this.#model = opts.model;
    this.#samples = Math.max(1, opts.samples ?? 3);
    this.#requirePassMajority = opts.requirePassMajority ?? false;
    this.#maxArtifactChars = opts.maxArtifactChars ?? 8000;
    this.#temperature = opts.temperature ?? 0.1;
    this.#maxTokens = opts.maxTokens ?? 400;
  }

  async verify(criterion: Criterion, ws: WorkspaceReader): Promise<CriterionVerdict> {
    // Resolve the artifact the judge will read. If the criterion names
    // a path, fetch + truncate. Otherwise we judge against null and
    // the prompt will lead the model toward `pass: false`.
    let artifact: string | null = null;
    if (criterion.path) {
      try {
        if (await ws.fileExists(criterion.path)) {
          const body = await ws.readFile(criterion.path);
          artifact =
            body.length <= this.#maxArtifactChars
              ? body
              : `${body.slice(0, this.#maxArtifactChars)}\n…[truncated, ${body.length - this.#maxArtifactChars} chars omitted]`;
        }
      } catch (e) {
        return {
          ok: false,
          criterionId: criterion.id,
          hint: `LLMJudgeVerifier failed to read ${criterion.path}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // K independent judge calls. We run them sequentially rather than
    // in parallel — keeps streaming-enabled providers' rate limits
    // happy and gives the operator a deterministic ordering for
    // logging. K is small (default 3) so latency cost is bounded.
    const votes: (JudgeReply | null)[] = [];
    for (let i = 0; i < this.#samples; i++) {
      try {
        votes.push(
          await singleJudgeCall(this.#model, criterion, artifact, {
            temperature: this.#temperature,
            maxTokens: this.#maxTokens,
          })
        );
      } catch (_e) {
        // A judge call that throws is counted as a fail vote — the
        // verifier does not "trust the executor more because the judge
        // failed." Hint reports the raw error for the next iteration's
        // debugging.
        votes.push(null);
      }
    }

    const passCount = votes.filter((v) => v?.pass === true).length;
    const failVotes = votes.filter((v) => v?.pass === false);
    // Aggregation. Default policy: require all samples to vote pass —
    // any dissent fails. Majority policy: > half must pass.
    const decision = this.#requirePassMajority
      ? passCount * 2 > this.#samples
      : passCount === this.#samples;

    if (decision) {
      return { ok: true, criterionId: criterion.id };
    }
    // Compose a hint from the first dissenting vote's reasoning, plus
    // the vote tally. Keeps the hint short enough to fit in next
    // iteration's prompt without bloating context.
    const dissent = failVotes[0]?.reasoning ?? "judge replied unparseable JSON";
    const tally = `${passCount}/${this.#samples} passed${this.#requirePassMajority ? "" : " (need all)"}`;
    return {
      ok: false,
      criterionId: criterion.id,
      hint: `${dissent} [${tally}]`,
    };
  }
}
