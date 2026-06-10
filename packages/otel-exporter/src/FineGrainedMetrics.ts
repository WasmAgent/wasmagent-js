/**
 * Fine-grained metric collector — accumulates per-step latency,
 * per-tool error counts, and other granular numbers for export.
 *
 * Pair with the existing OtlpHttpExporter: pass the same exporter
 * instance and call `flush()` at the end of a run to push everything.
 */

export interface StepMetric {
  stepIndex: number;
  durationMs: number;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ToolErrorMetric {
  toolName: string;
  count: number;
}

export interface MetricsSnapshot {
  steps: StepMetric[];
  toolErrors: ToolErrorMetric[];
  /** Total tokens across all steps. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export class FineGrainedMetrics {
  readonly #steps: StepMetric[] = [];
  readonly #toolErrors = new Map<string, number>();

  recordStep(metric: StepMetric): void {
    this.#steps.push(metric);
  }

  recordToolError(toolName: string): void {
    this.#toolErrors.set(toolName, (this.#toolErrors.get(toolName) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    let inT = 0;
    let outT = 0;
    let cost = 0;
    for (const s of this.#steps) {
      inT += s.inputTokens;
      outT += s.outputTokens;
      cost += s.costUsd;
    }
    const toolErrors: ToolErrorMetric[] = [...this.#toolErrors.entries()].map(
      ([toolName, count]) => ({
        toolName,
        count,
      })
    );
    return {
      steps: [...this.#steps],
      toolErrors,
      totalInputTokens: inT,
      totalOutputTokens: outT,
      totalCostUsd: cost,
    };
  }

  reset(): void {
    this.#steps.length = 0;
    this.#toolErrors.clear();
  }
}
