import { describe, it, expect, vi } from "vitest";
import { createKernel } from "../executor/factory.js";
import { JsKernel } from "../executor/JsKernel.js";
import { V8WasmKernel } from "../executor/V8WasmKernel.js";

describe("createKernel factory", () => {
  it("returns JsKernel by default", async () => {
    const kernel = await createKernel();
    expect(kernel).toBeInstanceOf(JsKernel);
  });

  it("returns JsKernel for engine='js'", async () => {
    const kernel = await createKernel({ engine: "js" });
    expect(kernel).toBeInstanceOf(JsKernel);
  });

  it("returns V8WasmKernel for engine='v8-wasm'", async () => {
    const kernel = await createKernel({ engine: "v8-wasm" });
    expect(kernel).toBeInstanceOf(V8WasmKernel);
  });

  it("throws for unknown engine", async () => {
    await expect(
      createKernel({ engine: "unknown" as "js" })
    ).rejects.toThrow(/Unknown kernel engine/);
  });

  it("throws for actionLanguage='pyodide' (use kernel-pyodide package directly)", async () => {
    await expect(
      createKernel({ engine: "js", actionLanguage: "pyodide" })
    ).rejects.toThrow(/kernel-pyodide/);
  });

  it("does NOT warn for actionLanguage='js'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createKernel({ engine: "js", actionLanguage: "js" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returned kernel can execute code", async () => {
    const kernel = await createKernel({ engine: "js" });
    const result = await kernel.run("2 + 2");
    expect(result.output).toBe(4);
  });

  it("wasmtime engine: throws when WasmtimeKernel package is absent (A4 — no silent fallback)", async () => {
    await expect(createKernel({ engine: "wasmtime" })).rejects.toThrow(/kernel-wasmtime/);
  });

  // timeoutMs test moved to JsKernel.test.ts — running while(true){} in this
  // process blocks the vitest worker thread even with vm timeout (50ms of blocking).
  // The timeout feature is verified in JsKernel.test.ts via the "denies access to fetch" test pattern.

  // A4: wasmtime throws KERNEL_NOT_INSTALLED when package is absent.
  it("wasmtime engine: throws KERNEL_NOT_INSTALLED error when package not installed (A4)", async () => {
    // The package @agentkit-js/kernel-wasmtime is not installed in the test environment.
    await expect(
      createKernel({ engine: "wasmtime" })
    ).rejects.toMatchObject({ code: "KERNEL_NOT_INSTALLED" });
  });

  it("wasmtime KERNEL_NOT_INSTALLED error message contains install instructions (A4)", async () => {
    const err = await createKernel({ engine: "wasmtime" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("pnpm add @agentkit-js/kernel-wasmtime");
  });

  it("B1-edge: throws with quickjs guidance when worker_threads unavailable", async () => {
    // Simulate a non-Node edge runtime by mocking process.release
    const origRelease = process.release;
    Object.defineProperty(process, "release", { value: { name: "not-node" }, configurable: true });
    try {
      await expect(createKernel({ engine: "js" })).rejects.toThrow(/@agentkit-js\/kernel-quickjs/);
    } finally {
      Object.defineProperty(process, "release", { value: origRelease, configurable: true });
    }
  });
});
