/**
 * RepairLLM — the minimum interface the LLM-backed repair strategies
 * need. One method: `complete(prompt, opts) → string`.
 *
 * # Why not depend on `@wasmagent/core`'s `Model` directly
 *
 * `@wasmagent/core` exposes a rich `Model` / `ModelClient` surface
 * (streaming, tool calls, message arrays). Repair only needs
 * text-in/text-out. Coupling to the full Model interface would force
 * every repair test to set up a fake message-array transport.
 *
 * The compliance package introduces this tiny shim instead. A future
 * adapter in `packages/compliance/src/runner/` will wrap a
 * `@wasmagent/core` `Model` into a `RepairLLM` — that's the only
 * boundary that touches the heavy interface.
 *
 * # Determinism contract
 *
 * `RepairLLM` does not require determinism — production models are
 * stochastic. Tests use `FakeRepairLLM` (in this file) for deterministic
 * behaviour. The repair planner itself MUST handle both kinds; that's
 * tested by feeding planner tests a fake whose response is keyed on
 * the prompt content.
 */

export interface RepairLLMRequest {
  prompt: string;
  /**
   * Optional generation cap. Strategies set this to keep regenerations
   * bounded (e.g. region rewrites should not exceed the original
   * region by much). The LLM may return less; it MUST not return more.
   */
  max_tokens?: number;
  /**
   * Optional temperature. Repair callers typically want low (≤0.3)
   * because they are constraint-driven, not creative.
   */
  temperature?: number;
}

export interface RepairLLMResponse {
  text: string;
  /** Optional token-usage telemetry for the RepairTrace.token_cost field. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface RepairLLM {
  complete(request: RepairLLMRequest): Promise<RepairLLMResponse>;
}

// ── FakeRepairLLM — deterministic test double ───────────────────────────────

/**
 * Lookup-based fake. Tests configure a list of (matcher, response)
 * pairs; the first matcher whose predicate returns true wins. If
 * nothing matches, the fake throws — making "unexpected prompt" a
 * loud test failure rather than a silent default.
 *
 * Records every call into `calls` for assertions.
 *
 * Example:
 *
 *   const llm = new FakeRepairLLM([
 *     { match: (p) => p.includes("rewrite"), reply: "fresh body" },
 *   ]);
 *   await llm.complete({prompt: "please rewrite ..."});  // "fresh body"
 */
export interface FakeRepairLLMRule {
  match: (prompt: string) => boolean;
  reply: string | ((prompt: string) => string);
  usage?: RepairLLMResponse["usage"];
}

export class FakeRepairLLM implements RepairLLM {
  readonly calls: RepairLLMRequest[] = [];
  readonly #rules: FakeRepairLLMRule[];

  constructor(rules: FakeRepairLLMRule[] = []) {
    this.#rules = rules;
  }

  /** Append a rule at runtime. Tests may want a stack-based setup. */
  push(rule: FakeRepairLLMRule): void {
    this.#rules.push(rule);
  }

  async complete(request: RepairLLMRequest): Promise<RepairLLMResponse> {
    this.calls.push(request);
    for (const rule of this.#rules) {
      if (rule.match(request.prompt)) {
        const text = typeof rule.reply === "function" ? rule.reply(request.prompt) : rule.reply;
        return {
          text,
          ...(rule.usage ? { usage: rule.usage } : {}),
        };
      }
    }
    throw new Error(
      `FakeRepairLLM: no matching rule for prompt (first 200 chars): ${request.prompt.slice(0, 200)}`
    );
  }
}
