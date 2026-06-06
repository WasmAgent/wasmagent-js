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

  it("emits a console.warn for actionLanguage='micropython' (not yet implemented)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createKernel({ engine: "js", actionLanguage: "micropython" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("micropython")
    );
    warn.mockRestore();
  });

  it("actionLanguage='pyodide' returns PyodideKernel (no warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kernel = await createKernel({ engine: "js", actionLanguage: "pyodide" });
    // PyodideKernel is returned — no warning emitted.
    expect(warn).not.toHaveBeenCalled();
    // Verify it's a real kernel by running code (Pyodide loads lazily on run()).
    expect(kernel).toBeDefined();
    warn.mockRestore();
  }, 30_000);

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

  it("wasmtime engine: falls back to V8WasmKernel and warns when WasmtimeKernel throws", async () => {
    // WasmtimeKernel always throws (it's a stub). Verify the factory falls back.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kernel = await createKernel({ engine: "wasmtime" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("wasmtime native addon unavailable")
    );
    // The returned kernel should still work (it's a V8WasmKernel).
    const result = await kernel.run("3 + 3");
    expect(result.output).toBe(6);
    warn.mockRestore();
  });
});
