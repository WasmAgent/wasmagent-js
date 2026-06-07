import { describe, it, expect, beforeEach } from "vitest";
import { WasmtimeKernel, buildJavySource } from "./WasmtimeKernel.js";

// ---------------------------------------------------------------------------
// Harness tests run the generated JS in Node.js with a Javy.IO shim.
// This lets us verify correctness of buildJavySource without needing javy CLI.
// ---------------------------------------------------------------------------

async function simulateHarnessRun(
  source: string,
  stdinData: string
): Promise<{ stdout: string; stderr: string }> {
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];

  const JavyIO = {
    readSync: (_fd: number) => new TextEncoder().encode(stdinData),
    writeSync: (fd: number, buf: Uint8Array) => {
      const text = new TextDecoder().decode(buf);
      if (fd === 1) stdoutParts.push(text);
      else stderrParts.push(text);
    },
  };

  const fn = new Function("Javy", `"use strict";\n${source}`);
  fn({ IO: JavyIO });

  return {
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
  };
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter(Boolean);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

function parseState(stdout: string): Record<string, string> {
  const lines = stdout.split("\n").filter(Boolean);
  return JSON.parse(lines[1] ?? "{}") as Record<string, string>;
}

describe("buildJavySource harness (unit, no javy CLI required)", () => {
  it("emits output for simple expression", async () => {
    const src = buildJavySource("1 + 2", [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["output"]).toBe(3);
    expect(parseEnvelope(stdout)["isFinalAnswer"]).toBe(false);
  });

  it("captures console.log in stderr", async () => {
    const src = buildJavySource('console.log("hello"); 42', [], {});
    const { stdout, stderr } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["output"]).toBe(42);
    expect(stderr).toContain("hello");
  });

  it("signals final answer via __finalAnswer__", async () => {
    const src = buildJavySource('__finalAnswer__ = "done";', [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["isFinalAnswer"]).toBe(true);
    expect(parseEnvelope(stdout)["finalAnswer"]).toBe("done");
  });

  it("signals final answer via __final_answer__ (snake_case alias)", async () => {
    const src = buildJavySource("__final_answer__ = 99;", [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["isFinalAnswer"]).toBe(true);
    expect(parseEnvelope(stdout)["finalAnswer"]).toBe(99);
  });

  it("captures error in envelope.error", async () => {
    const src = buildJavySource("throw new Error('boom');", [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["error"]).toBe("boom");
  });

  it("restores prior state and persists new state across simulated runs", async () => {
    // First run: set x = 10
    const src1 = buildJavySource("var x = 10; x", [], {});
    const { stdout: out1 } = await simulateHarnessRun(src1, "{}");
    const state1 = parseState(out1);
    expect(state1["x"]).toBe("10");

    // Second run: restore state1, x * 2
    const src2 = buildJavySource("x * 2", [], state1);
    const { stdout: out2 } = await simulateHarnessRun(src2, JSON.stringify(state1));
    expect(parseEnvelope(out2)["output"]).toBe(20);
  });

  it("denies fetch when allowedHosts is empty", async () => {
    const src = buildJavySource('typeof globalThis.fetch === "undefined"', [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["output"]).toBe(true);
  });

  it("throws CapabilityDenied for disallowed host", async () => {
    const src = buildJavySource(
      '(function(){ try { fetch("https://evil.com/"); return "no-throw"; } catch(e) { return e.message; } })()',
      ["example.com"],
      {}
    );
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(String(parseEnvelope(stdout)["output"])).toContain("CapabilityDenied");
  });

  it("does not leak harness internals into state bag", async () => {
    const src = buildJavySource("var userVar = 7;", [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    const state = parseState(stdout);
    expect(state["userVar"]).toBe("7");
    expect(state["__logs__"]).toBeUndefined();
    expect(state["__state__"]).toBeUndefined();
    expect(state["console"]).toBeUndefined();
  });

  it("null is a valid final answer", async () => {
    const src = buildJavySource("__finalAnswer__ = null;", [], {});
    const { stdout } = await simulateHarnessRun(src, "{}");
    expect(parseEnvelope(stdout)["isFinalAnswer"]).toBe(true);
    expect(parseEnvelope(stdout)["finalAnswer"]).toBeNull();
  });
});

describe("WasmtimeKernel API (unit, javy mocked)", () => {
  it("throws helpful error when javy CLI is not found", async () => {
    const k = new WasmtimeKernel({ javyPath: "/nonexistent/javy-binary-xyz" });
    await expect(k.run("1+1")).rejects.toThrow(/javy.*not found/i);
  });

  it("snapshot() returns a Uint8Array of empty state bag initially", async () => {
    const k = new WasmtimeKernel();
    const snap = await k.snapshot();
    expect(snap).toBeInstanceOf(Uint8Array);
    const parsed = JSON.parse(new TextDecoder().decode(snap)) as Record<string, string>;
    expect(Object.keys(parsed).length).toBe(0);
  });

  it("restore() loads state bag", async () => {
    const k = new WasmtimeKernel();
    const state: Record<string, string> = { myVar: "42" };
    await k.restore(new TextEncoder().encode(JSON.stringify(state)));
    const snap = await k.snapshot();
    const restored = JSON.parse(new TextDecoder().decode(snap)) as Record<string, string>;
    expect(restored["myVar"]).toBe("42");
  });

  it("reset() clears state bag", async () => {
    const k = new WasmtimeKernel();
    await k.restore(new TextEncoder().encode(JSON.stringify({ x: "5" })));
    await k.reset();
    const snap = await k.snapshot();
    const after = JSON.parse(new TextDecoder().decode(snap)) as Record<string, string>;
    expect(Object.keys(after).length).toBe(0);
  });

  it("[Symbol.asyncDispose] clears state", async () => {
    const k = new WasmtimeKernel();
    await k.restore(new TextEncoder().encode(JSON.stringify({ x: "5" })));
    await k[Symbol.asyncDispose]();
    const snap = await k.snapshot();
    const after = JSON.parse(new TextDecoder().decode(snap)) as Record<string, string>;
    expect(Object.keys(after).length).toBe(0);
  });
});
