/**
 * @wasmagent/mastra-sandbox tests.
 *
 * The provider is a thin adapter over `Kernel.run()`. We pin:
 *  1. Happy path returns `{ output, stderr, exitCode: 0 }`.
 *  2. Capability denial lands as `exitCode: 1` with the error in `stderr`.
 *  3. Per-call `timeout` tightens the kernel's default deadline.
 *  4. Per-call `env` merges with provider-level env (call wins on conflict).
 */

import { JsKernel } from "@wasmagent/core";
import { describe, expect, it } from "vitest";
import { agentkitMastraSandbox } from "./index.js";

describe("agentkitMastraSandbox", () => {
  it("returns the kernel output stringified, with logs as stderr", async () => {
    const sandbox = agentkitMastraSandbox({ kernel: new JsKernel() });
    const result = await sandbox.execute("console.log('hello'); ({ a: 1, b: [2,3] })");
    expect(result.exitCode).toBe(0);
    // JsKernel returns the JSON-cloneable object directly; we stringify.
    expect(result.output).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
    expect(result.stderr).toContain("hello");
  });

  it("surfaces capability denials as exitCode 1", async () => {
    const sandbox = agentkitMastraSandbox({
      kernel: new JsKernel(),
      capabilities: { allowedHosts: ["api.example.com"] },
    });
    const result = await sandbox.execute("fetch('https://evil.com/data')");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/CapabilityDenied/);
    expect(result.output).toBe("");
  });

  it("per-call timeout tightens the kernel default", async () => {
    // JsKernel default is 5000ms — pass timeout: 100 to shrink it.
    const sandbox = agentkitMastraSandbox({ kernel: new JsKernel({ timeoutMs: 5_000 }) });
    const start = Date.now();
    const result = await sandbox.execute("while(true){}", { timeout: 100 });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/timed out/);
    // Generous slack for CI noise — point is "much less than 5000".
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  it("per-call env merges with provider-level env (call wins on conflict)", async () => {
    const sandbox = agentkitMastraSandbox({
      kernel: new JsKernel(),
      capabilities: { env: { REGION: "us", APP: "demo" } },
    });
    const result = await sandbox.execute(
      "JSON.stringify({region: __env__.REGION, app: __env__.APP})",
      { env: { REGION: "eu" } }
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.region).toBe("eu");
    expect(parsed.app).toBe("demo");
  });
});
