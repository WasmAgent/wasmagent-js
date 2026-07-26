import type { KernelExecutionError, KernelResult } from "./types.js";

describe("KernelResult (Milestone 3 — structured execution results)", () => {
  it("still accepts the original three-field shape", () => {
    // Existing kernels construct only {output, logs, isFinalAnswer}; that must
    // keep type-checking after the optional structured fields were added.
    const result: KernelResult = {
      output: 42,
      logs: ["hello"],
      isFinalAnswer: false,
    };
    expect(result.output).toBe(42);
    expect(result.logs).toStrictEqual(["hello"]);
    expect(result.isFinalAnswer).toBe(false);
  });

  it("carries stdout, stderr, returnValue, timedOut, and error details", () => {
    const error: KernelExecutionError = {
      name: "RangeError",
      message: "Invalid array length",
      stack: "RangeError: Invalid array length\n  at <anonymous>:1:1",
    };
    const result: KernelResult = {
      output: undefined,
      logs: [],
      isFinalAnswer: false,
      stdout: "hello on stdout\n",
      stderr: "warn on stderr\n",
      returnValue: 0,
      timedOut: false,
      error,
    };
    expect(result.stdout).toBe("hello on stdout\n");
    expect(result.stderr).toBe("warn on stderr\n");
    expect(result.returnValue).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.error?.name).toBe("RangeError");
    expect(result.error?.message).toBe("Invalid array length");
    expect(result.error?.stack).toContain("RangeError");
  });

  it("supports a timed-out execution result", () => {
    // A kernel that returns a partial result on timeout sets timedOut = true
    // rather than (or in addition to) rejecting the run() promise.
    const result: KernelResult = {
      output: undefined,
      logs: [],
      isFinalAnswer: false,
      stdout: "partial output before deadline\n",
      timedOut: true,
    };
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("partial output before deadline\n");
    expect(result.error).toBeUndefined();
  });

  it("KernelExecutionError requires name and message, stack is optional", () => {
    const minimal: KernelExecutionError = {
      name: "Error",
      message: "boom",
    };
    expect(minimal.stack).toBeUndefined();
    expect(minimal.name).toBe("Error");
  });
});
