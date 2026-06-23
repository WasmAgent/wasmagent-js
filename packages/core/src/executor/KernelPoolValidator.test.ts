import type { ValidationTask } from "./KernelPoolValidator.js";
import { KernelPoolValidator } from "./KernelPoolValidator.js";
import type { KernelResult, WasmKernel } from "./types.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeKernel(outputFn: (code: string) => string | Promise<string>): WasmKernel {
  return {
    async run(code: string): Promise<KernelResult> {
      const output = await outputFn(code);
      return { output, logs: [], isFinalAnswer: false };
    },
    async reset() {},
    async [Symbol.asyncDispose]() {},
  };
}

function makeThrowingKernel(): WasmKernel {
  return {
    async run(): Promise<KernelResult> {
      throw new Error("kernel exploded");
    },
    async reset() {},
    async [Symbol.asyncDispose]() {},
  };
}

function task(id: string, code: string, expectedOutputContains?: string): ValidationTask {
  return { id, code, expectedOutputContains };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("KernelPoolValidator", () => {
  test("all kernels agree → all trustworthy: true", async () => {
    const validator = new KernelPoolValidator();
    const tasks = [task("t1", "1+1"), task("t2", "2+2")];
    const factory = async (_id: string) => makeKernel(() => "42");
    const results = await validator.validate(tasks, factory, ["k1", "k2", "k3"]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.trustworthy).toBe(true);
      expect(r.failed).toBe(0);
      expect(r.passed).toBe(2);
    }
  });

  test("one kernel returns different output → that kernel is trustworthy: false, others remain true", async () => {
    const validator = new KernelPoolValidator();
    const tasks = [task("t1", "code")];
    const factory = async (kernelId: string) =>
      makeKernel(() => (kernelId === "odd-one" ? "wrong" : "correct"));
    const results = await validator.validate(tasks, factory, ["k1", "k2", "odd-one"]);

    const normal = results.filter((r) => r.kernelId !== "odd-one");
    const outlier = results.find((r) => r.kernelId === "odd-one");

    for (const r of normal) {
      expect(r.trustworthy).toBe(true);
    }
    expect(outlier!.trustworthy).toBe(false);
    expect(outlier!.failed).toBe(1);
  });

  test("kernel throws → treated as '<error>', counted as failed if others disagree", async () => {
    const validator = new KernelPoolValidator();
    const tasks = [task("t1", "code")];
    const factory = async (kernelId: string): Promise<WasmKernel> => {
      if (kernelId === "broken") return makeThrowingKernel();
      return makeKernel(() => "success");
    };
    const results = await validator.validate(tasks, factory, ["k1", "k2", "broken"]);

    const broken = results.find((r) => r.kernelId === "broken")!;
    expect(broken.trustworthy).toBe(false);
    expect(broken.taskResults[0]!.output).toBe("<error>");
    expect(broken.taskResults[0]!.agreed).toBe(false);
  });

  test("expectedOutputContains fails a kernel even when it matches majority", async () => {
    const validator = new KernelPoolValidator();
    // All kernels return "hello world" but task expects "goodbye"
    const tasks = [task("t1", "code", "goodbye")];
    const factory = async (_id: string) => makeKernel(() => "hello world");
    const results = await validator.validate(tasks, factory, ["k1", "k2", "k3"]);

    for (const r of results) {
      expect(r.trustworthy).toBe(false);
      expect(r.failed).toBe(1);
      expect(r.taskResults[0]!.agreed).toBe(false);
    }
  });

  test("expectedOutputContains passes a kernel when output contains expected string", async () => {
    const validator = new KernelPoolValidator();
    const tasks = [task("t1", "code", "hello")];
    const factory = async (_id: string) => makeKernel(() => "hello world");
    const results = await validator.validate(tasks, factory, ["k1", "k2"]);

    for (const r of results) {
      expect(r.trustworthy).toBe(true);
      expect(r.taskResults[0]!.agreed).toBe(true);
    }
  });

  test("empty task list → all kernels pass with passed: 0, failed: 0, trustworthy: true", async () => {
    const validator = new KernelPoolValidator();
    const factory = async (_id: string) => makeKernel(() => "anything");
    const results = await validator.validate([], factory, ["k1", "k2"]);

    for (const r of results) {
      expect(r.passed).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.trustworthy).toBe(true);
      expect(r.taskResults).toHaveLength(0);
    }
  });

  test("single kernel → always trustworthy: true (no disagreement possible)", async () => {
    const validator = new KernelPoolValidator();
    const tasks = [task("t1", "code")];
    const factory = async (_id: string) => makeKernel(() => "result");
    const results = await validator.validate(tasks, factory, ["only-kernel"]);

    expect(results).toHaveLength(1);
    expect(results[0]!.trustworthy).toBe(true);
    expect(results[0]!.passed).toBe(1);
    expect(results[0]!.failed).toBe(0);
  });

  test("empty kernelIds → returns empty array", async () => {
    const validator = new KernelPoolValidator();
    const factory = async (_id: string) => makeKernel(() => "x");
    const results = await validator.validate([task("t1", "code")], factory, []);
    expect(results).toHaveLength(0);
  });

  test("taskResults contain correct taskId and output per task", async () => {
    const validator = new KernelPoolValidator();
    const tasks = [task("alpha", "codeA"), task("beta", "codeB")];
    const factory = async (_id: string) => makeKernel((code) => `out:${code}`);
    const results = await validator.validate(tasks, factory, ["k1"]);

    const r = results[0]!;
    expect(r.taskResults).toHaveLength(2);
    const alpha = r.taskResults.find((t) => t.taskId === "alpha")!;
    const beta = r.taskResults.find((t) => t.taskId === "beta")!;
    expect(alpha.output).toBe("out:codeA");
    expect(beta.output).toBe("out:codeB");
  });

  test("constructor stores sampleRate and majorityThreshold options", () => {
    const validator = new KernelPoolValidator({ sampleRate: 0.1, majorityThreshold: 3 });
    expect(validator.sampleRate).toBe(0.1);
    expect(validator.majorityThreshold).toBe(3);
  });

  test("tie-break: first alphabetically among equally frequent outputs wins majority", async () => {
    const validator = new KernelPoolValidator();
    // k1 → "apple", k2 → "zebra" — tie, "apple" wins alphabetically
    const tasks = [task("t1", "code")];
    const factory = async (kernelId: string) =>
      makeKernel(() => (kernelId === "k1" ? "apple" : "zebra"));
    const results = await validator.validate(tasks, factory, ["k1", "k2"]);

    const k1 = results.find((r) => r.kernelId === "k1")!;
    const k2 = results.find((r) => r.kernelId === "k2")!;
    // "apple" < "zebra" alphabetically, so k1 (apple) agrees with majority
    expect(k1.trustworthy).toBe(true);
    expect(k2.trustworthy).toBe(false);
  });
});
