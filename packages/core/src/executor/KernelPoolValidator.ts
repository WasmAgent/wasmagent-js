import type { WasmKernel } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ValidationTask {
  id: string;
  code: string;
  expectedOutputContains?: string;
}

export interface KernelValidationResult {
  kernelId: string;
  passed: number;
  failed: number;
  /** true = this kernel's results agreed with majority on all tasks */
  trustworthy: boolean;
  taskResults: Array<{ taskId: string; output: string; agreed: boolean }>;
}

export interface KernelPoolValidatorOptions {
  /** Fraction of rollout tasks to re-run for cross-validation. Default: 0.05 (5%). */
  sampleRate?: number;
  /** Minimum number of kernels that must agree for a result to be "majority". Default: 2. */
  majorityThreshold?: number;
}

// ── KernelPoolValidator ───────────────────────────────────────────────────────

export class KernelPoolValidator {
  readonly #sampleRate: number;
  readonly #majorityThreshold: number;

  constructor(opts: KernelPoolValidatorOptions = {}) {
    this.#sampleRate = opts.sampleRate ?? 0.05;
    this.#majorityThreshold = opts.majorityThreshold ?? 2;
  }

  async validate(
    tasks: ValidationTask[],
    kernelFactory: (kernelId: string) => Promise<WasmKernel>,
    kernelIds: string[]
  ): Promise<KernelValidationResult[]> {
    if (kernelIds.length === 0) return [];

    // Run all tasks on all kernels, collecting per-kernel per-task outputs.
    const outputMatrix = new Map<string, Map<string, string>>();
    for (const kernelId of kernelIds) {
      const taskOutputs = new Map<string, string>();
      const kernel = await kernelFactory(kernelId);
      for (const task of tasks) {
        let output: string;
        try {
          const result = await kernel.run(task.code);
          output = result.output == null ? "" : String(result.output);
        } catch {
          output = "<error>";
        }
        taskOutputs.set(task.id, output);
      }
      outputMatrix.set(kernelId, taskOutputs);
    }

    // Determine majority output per task.
    const majorityOutputs = new Map<string, string>();
    for (const task of tasks) {
      const counts = new Map<string, number>();
      for (const kernelId of kernelIds) {
        const out = outputMatrix.get(kernelId)?.get(task.id) ?? "";
        counts.set(out, (counts.get(out) ?? 0) + 1);
      }
      // Tie-break: first alphabetically among outputs with max count.
      let maxCount = 0;
      let majority = "";
      for (const [out, count] of counts) {
        if (count > maxCount || (count === maxCount && out < majority)) {
          maxCount = count;
          majority = out;
        }
      }
      majorityOutputs.set(task.id, majority);
    }

    // Build per-kernel results.
    const results: KernelValidationResult[] = [];
    for (const kernelId of kernelIds) {
      const taskOutputs = outputMatrix.get(kernelId)!;
      const taskResults: KernelValidationResult["taskResults"] = [];
      let passed = 0;
      let failed = 0;

      for (const task of tasks) {
        const output = taskOutputs.get(task.id) ?? "";
        const majorityOutput = majorityOutputs.get(task.id) ?? "";
        let agreed = output === majorityOutput;

        // expectedOutputContains check overrides agreement — even a majority-matching
        // kernel fails if its output doesn't contain the expected string.
        if (
          task.expectedOutputContains !== undefined &&
          !output.includes(task.expectedOutputContains)
        ) {
          agreed = false;
        }

        taskResults.push({ taskId: task.id, output, agreed });
        if (agreed) {
          passed++;
        } else {
          failed++;
        }
      }

      results.push({
        kernelId,
        passed,
        failed,
        trustworthy: failed === 0,
        taskResults,
      });
    }

    return results;
  }

  get sampleRate(): number {
    return this.#sampleRate;
  }

  get majorityThreshold(): number {
    return this.#majorityThreshold;
  }
}
