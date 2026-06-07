/**
 * Tests for CLI helper functions and runCommand.
 *
 * Strategy:
 * - Pure functions (parseEventsFilter, camelCase, generateToolTemplate) are tested directly.
 * - runCommand is tested with vi.mock for @agentkit-js/core to avoid real API calls.
 * - stdout/stderr/console are spied on to verify output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseEventsFilter, camelCase, generateToolTemplate, generateTestTemplate, runCommand } from "./index.js";
import type { AgentEvent } from "@agentkit-js/core";

// ── Mock @agentkit-js/core ────────────────────────────────────────────────────

let mockAgentEvents: AgentEvent[] = [];

vi.mock("@agentkit-js/core", () => ({
  CodeAgent: class {
    constructor(_opts: unknown) {}
    run(_task: string) {
      return (async function* () {
        for (const e of mockAgentEvents) yield e;
      })();
    }
  },
  AnthropicModel: class {
    constructor(_modelId: string, _apiKey?: string) {}
  },
}));

// ── parseEventsFilter ─────────────────────────────────────────────────────────

describe("parseEventsFilter", () => {
  it("non-stream mode with no filter returns default event set", () => {
    const filter = parseEventsFilter(undefined, false);
    expect(filter.has("final_answer")).toBe(true);
    expect(filter.has("error")).toBe(true);
    expect(filter.has("step_start")).toBe(true);
    expect(filter.has("thinking_delta")).toBe(true);
    // run_start is excluded from default non-stream filter
    expect(filter.has("run_start")).toBe(false);
  });

  it("stream mode with no filter returns all event types", () => {
    const filter = parseEventsFilter(undefined, true);
    expect(filter.has("run_start")).toBe(true);
    expect(filter.has("thinking_delta")).toBe(true);
    expect(filter.has("tool_call")).toBe(true);
    expect(filter.has("final_answer")).toBe(true);
  });

  it("parses comma-separated event names", () => {
    const filter = parseEventsFilter("final_answer,error", false);
    expect(filter.has("final_answer")).toBe(true);
    expect(filter.has("error")).toBe(true);
    expect(filter.has("step_start")).toBe(false);
  });

  it("strips whitespace around event names", () => {
    const filter = parseEventsFilter("final_answer , error", false);
    expect(filter.has("final_answer")).toBe(true);
    expect(filter.has("error")).toBe(true);
  });

  it("skips unknown event types", () => {
    const filter = parseEventsFilter("final_answer,unknown_event,error", false);
    expect(filter.has("final_answer")).toBe(true);
    expect(filter.has("error")).toBe(true);
    expect(filter.size).toBe(2);
  });

  it("empty string filter is treated as no filter (returns default set)", () => {
    // empty string is falsy, so no filter is applied — returns default non-stream set
    const filter = parseEventsFilter("", false);
    expect(filter.has("final_answer")).toBe(true);
    expect(filter.size).toBeGreaterThan(0);
  });
});

// ── camelCase ─────────────────────────────────────────────────────────────────

describe("camelCase", () => {
  it("lowercases first letter of PascalCase", () => {
    expect(camelCase("WebSearch")).toBe("webSearch");
  });

  it("single word", () => {
    expect(camelCase("Calculator")).toBe("calculator");
  });

  it("already camelCase is unchanged beyond first char", () => {
    expect(camelCase("MyTool")).toBe("myTool");
  });

  it("single char", () => {
    expect(camelCase("A")).toBe("a");
  });
});

// ── generateToolTemplate ──────────────────────────────────────────────────────

describe("generateToolTemplate", () => {
  it("contains the tool name and pascal name", () => {
    const ts = generateToolTemplate("web-search", "WebSearch");
    expect(ts).toContain("web-search");
    expect(ts).toContain("WebSearch");
  });

  it("includes ToolDefinition import", () => {
    const ts = generateToolTemplate("my-tool", "MyTool");
    expect(ts).toContain("ToolDefinition");
    expect(ts).toContain("@agentkit-js/core");
  });

  it("includes readOnly and idempotent fields", () => {
    const ts = generateToolTemplate("my-tool", "MyTool");
    expect(ts).toContain("readOnly");
    expect(ts).toContain("idempotent");
  });

  it("includes forward() method stub", () => {
    const ts = generateToolTemplate("my-tool", "MyTool");
    expect(ts).toContain("forward");
  });
});

describe("generateTestTemplate", () => {
  it("contains the tool name", () => {
    const ts = generateTestTemplate("web-search", "WebSearch");
    expect(ts).toContain("web-search");
    expect(ts).toContain("WebSearch");
  });

  it("includes vitest imports", () => {
    const ts = generateTestTemplate("my-tool", "MyTool");
    expect(ts).toContain("vitest");
  });

  it("validates name and description", () => {
    const ts = generateTestTemplate("my-tool", "MyTool");
    expect(ts).toContain("name");
    expect(ts).toContain("description");
  });
});

// ── runCommand ────────────────────────────────────────────────────────────────

describe("runCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleLogSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints error when task is empty", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    await runCommand("", { "api-key": "sk-test" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("no task"));
    exitSpy.mockRestore();
  });

  it("prints error when no API key provided", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    // No ANTHROPIC_API_KEY in env, no --api-key flag
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    await runCommand("test task", {});
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));
    process.env["ANTHROPIC_API_KEY"] = savedKey;
    exitSpy.mockRestore();
  });

  it("outputs Final answer for final_answer event", async () => {
    mockAgentEvents = [{
      traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer",
      data: { answer: "The answer is 42" }, timestampMs: 0,
    }];
    await runCommand("What is 6*7?", { "api-key": "sk-test" });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Final answer:"),
      "The answer is 42"
    );
  });

  it("outputs error for error event", async () => {
    mockAgentEvents = [{
      traceId: "t1", parentTraceId: null, channel: "text", event: "error",
      data: { error: "something broke" }, timestampMs: 0,
    }];
    await runCommand("fail", { "api-key": "sk-test" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error:"),
      "something broke"
    );
  });

  it("writes thinking_delta to stdout", async () => {
    mockAgentEvents = [
      {
        traceId: "t1", parentTraceId: null, channel: "thinking", event: "thinking_delta",
        data: { delta: "thinking...", step: 1 }, timestampMs: 0,
      },
      {
        traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer",
        data: { answer: "done" }, timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test" });
    expect(stdoutSpy).toHaveBeenCalledWith("thinking...");
  });

  it("writes step_start to stderr", async () => {
    mockAgentEvents = [
      {
        traceId: "t1", parentTraceId: null, channel: "thinking", event: "step_start",
        data: { step: 1 }, timestampMs: 0,
      },
      {
        traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer",
        data: { answer: "done" }, timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test" });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[step 1]"));
  });

  it("stream mode outputs raw NDJSON to stdout", async () => {
    mockAgentEvents = [{
      traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer",
      data: { answer: "42" }, timestampMs: 0,
    }];
    await runCommand("test", { "api-key": "sk-test", stream: true });
    const calls = (stdoutSpy.mock.calls as unknown[][]).map((c) => c[0] as string);
    const hasJson = calls.some((c: string) => {
      try { JSON.parse(c); return true; } catch { return false; }
    });
    expect(hasJson).toBe(true);
  });

  it("tool_call event logs tool name and args", async () => {
    mockAgentEvents = [
      {
        traceId: "t1", parentTraceId: null, channel: "tool", event: "tool_call",
        data: { toolName: "calculator", args: { expression: "2+2" }, callId: "c1", batchId: "b1", batchSize: 1, stepIndex: 1 },
        timestampMs: 0,
      },
      {
        traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer",
        data: { answer: "4" }, timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test" });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("calculator")
    );
  });
});
