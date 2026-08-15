/**
 * Runtime health metrics — lightweight counters/gauges for agent operational health.
 * Records: tool latency, failures, timeouts, policy denials, and resource consumption.
 * Use HealthMetrics.getInstance() to access the process-wide singleton.
 */

export interface HealthSnapshot {
  latency: { count: number; totalMs: number; avgMs: number };
  failures: number;
  timeouts: number;
  policyDenials: number;
  resourceTokensUsed: number;
}

export class HealthMetrics {
  static readonly #instance = new HealthMetrics();

  #latencyCount = 0;
  #latencyTotalMs = 0;
  #failures = 0;
  #timeouts = 0;
  #policyDenials = 0;
  #resourceTokensUsed = 0;

  static getInstance(): HealthMetrics {
    return HealthMetrics.#instance;
  }

  /** Record a tool invocation latency in milliseconds. */
  recordLatency(ms: number): void {
    this.#latencyCount++;
    this.#latencyTotalMs += ms;
  }

  /** Record a tool execution failure (also incremented by recordTimeout). */
  recordFailure(): void {
    this.#failures++;
  }

  /** Record a tool execution that exceeded its deadline. */
  recordTimeout(): void {
    this.#timeouts++;
    this.#failures++;
  }

  /** Record a policy/guardrail denial that blocked a tool call or answer. */
  recordPolicyDenial(): void {
    this.#policyDenials++;
  }

  /** Record token resource consumption for a model call. */
  recordResourceUsage(tokens: number): void {
    this.#resourceTokensUsed += tokens;
  }

  /** Return a read-only snapshot of current metrics. */
  getSnapshot(): HealthSnapshot {
    const count = this.#latencyCount;
    return {
      latency: {
        count,
        totalMs: this.#latencyTotalMs,
        avgMs: count > 0 ? Math.round(this.#latencyTotalMs / count) : 0,
      },
      failures: this.#failures,
      timeouts: this.#timeouts,
      policyDenials: this.#policyDenials,
      resourceTokensUsed: this.#resourceTokensUsed,
    };
  }

  /** Reset all counters (intended for use in tests). */
  reset(): void {
    this.#latencyCount = 0;
    this.#latencyTotalMs = 0;
    this.#failures = 0;
    this.#timeouts = 0;
    this.#policyDenials = 0;
    this.#resourceTokensUsed = 0;
  }
}
