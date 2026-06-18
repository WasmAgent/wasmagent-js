/**
 * Tests for CLI helper functions and runCommand.
 *
 * Strategy:
 * - Pure functions (parseEventsFilter, camelCase, generateToolTemplate) are tested directly.
 * - runCommand is tested with vi.mock for @agentkit-js/core to avoid real API calls.
 * - stdout/stderr/console are spied on to verify output.
 */

import type { AgentEvent } from "@agentkit-js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  camelCase,
  generateTestTemplate,
  generateToolTemplate,
  parseEventsFilter,
  runCommand,
} from "./index.js";

// ── Mock @agentkit-js/core ────────────────────────────────────────────────────

let mockAgentEvents: AgentEvent[] = [];

vi.mock("@agentkit-js/core", () => ({
  CodeAgent: class {
    run(_task: string) {
      return (async function* () {
        for (const e of mockAgentEvents) yield e;
      })();
    }
  },
  AnthropicModel: class {},
  AnthropicModels: {
    OPUS_LATEST: "claude-opus-4-8",
    SONNET_LATEST: "claude-sonnet-4-6",
    HAIKU_LATEST: "claude-haiku-4-5-20251001",
  },
  // 2026-06-18: stubs for the new goal/verify CLI commands. Tests for
  // those commands script their own behaviour via mockAgentEvents (for
  // GoalDirectedAgent) or write a minimal criteria.json + sample files
  // and assert the verifier's pass/fail decision.
  GoalDirectedAgent: class {
    run(_task: string) {
      return (async function* () {
        for (const e of mockAgentEvents) yield e;
      })();
    }
  },
  DeterministicVerifier: class {
    methods = [
      "file_exists",
      "file_size_min",
      "file_contains",
      "headings_count_min",
      "word_count_min",
    ];
    async verify(criterion: { id: string; verify_method: string; arg?: unknown; path?: string }, ws: { fileExists: (p: string) => Promise<boolean>; fileSize: (p: string) => Promise<number>; readFile: (p: string) => Promise<string> }) {
      // Deliberately tiny re-implementation — enough for the verifyCommand
      // smoke test to discriminate pass/fail. The full deterministic
      // semantics are pinned by tests in packages/core itself.
      const id = criterion.id;
      const path = criterion.path ?? "";
      switch (criterion.verify_method) {
        case "file_exists":
          return (await ws.fileExists(path))
            ? { ok: true, criterionId: id }
            : { ok: false, criterionId: id, hint: `file ${path} missing` };
        case "file_size_min": {
          if (!(await ws.fileExists(path))) return { ok: false, criterionId: id, hint: "missing" };
          const size = await ws.fileSize(path);
          const min = Number(criterion.arg ?? 0);
          return size >= min
            ? { ok: true, criterionId: id }
            : { ok: false, criterionId: id, hint: `${size} < ${min}` };
        }
        default:
          return { ok: false, criterionId: id, hint: "unknown" };
      }
    }
  },
  VerificationPipeline: class {
    #ws: { fileExists: (p: string) => Promise<boolean>; fileSize: (p: string) => Promise<number>; readFile: (p: string) => Promise<string> };
    #v: { verify: (c: unknown, ws: unknown) => Promise<{ ok: boolean; criterionId: string; hint?: string }> };
    constructor(opts: { ws: unknown; verifiers: unknown[] }) {
      this.#ws = opts.ws as never;
      this.#v = (opts.verifiers as Array<{
        verify: (c: unknown, ws: unknown) => Promise<{ ok: boolean; criterionId: string; hint?: string }>;
      }>)[0]!;
    }
    async run(criteria: unknown[]) {
      const verdicts: Array<{ ok: boolean; criterionId: string; hint?: string }> = [];
      for (const c of criteria) verdicts.push(await this.#v.verify(c, this.#ws));
      const failing = verdicts.filter((v) => !v.ok);
      return failing.length === 0
        ? { ok: true, verdicts }
        : { ok: false, verdicts, hint: failing.map((v) => `- ${v.criterionId}: ${v.hint}`).join("\n") };
    }
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
  let stdoutSpy: any;
  let stderrSpy: any;
  let consoleLogSpy: any;
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
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await runCommand("test task", {});
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));
    process.env.ANTHROPIC_API_KEY = savedKey;
    exitSpy.mockRestore();
  });

  it("outputs Final answer for final_answer event", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "The answer is 42" },
        timestampMs: 0,
      },
    ];
    await runCommand("What is 6*7?", { "api-key": "sk-test" });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Final answer:"),
      "The answer is 42"
    );
  });

  it("outputs error for error event", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "error",
        data: { error: "something broke" },
        timestampMs: 0,
      },
    ];
    await runCommand("fail", { "api-key": "sk-test" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error:"),
      "something broke"
    );
  });

  it("writes thinking_delta to stdout", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "thinking",
        event: "thinking_delta",
        data: { delta: "thinking...", step: 1 },
        timestampMs: 0,
      },
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "done" },
        timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test" });
    expect(stdoutSpy).toHaveBeenCalledWith("thinking...");
  });

  it("writes step_start to stderr", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "thinking",
        event: "step_start",
        data: { step: 1 },
        timestampMs: 0,
      },
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "done" },
        timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test" });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[step 1]"));
  });

  it("stream mode outputs raw NDJSON to stdout", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "42" },
        timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test", stream: true });
    const calls = (stdoutSpy.mock.calls as unknown[][]).map((c) => c[0] as string);
    const hasJson = calls.some((c: string) => {
      try {
        JSON.parse(c);
        return true;
      } catch {
        return false;
      }
    });
    expect(hasJson).toBe(true);
  });

  it("tool_call event logs tool name and args", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "tool",
        event: "tool_call",
        data: {
          toolName: "calculator",
          args: { expression: "2+2" },
          callId: "c1",
          batchId: "b1",
          batchSize: 1,
          stepIndex: 1,
        },
        timestampMs: 0,
      },
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "4" },
        timestampMs: 0,
      },
    ];
    await runCommand("test", { "api-key": "sk-test" });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("calculator"));
  });
});

// ── modelCommand (L6, 2026-06-12) ─────────────────────────────────────────────

describe("modelCommand", () => {
  // Each test sets up a temp cache dir so we don't touch the real ~/.agentkit.
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error(`exit ${_code}`);
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("`list` prints every registered alias", async () => {
    const { modelCommand } = await import("./index.js");
    await modelCommand(["list"], {});
    const calls = (consoleLogSpy.mock.calls as unknown[][]).map((c) => String(c[0]));
    // qwen3.5-0.8b was retired in V3 (2026-06-13); qwen2.5-1.5b takes its slot
    // as the Qwen reference alias since it actually exists on HF.
    expect(calls.some((s) => s.includes("qwen2.5-1.5b"))).toBe(true);
    expect(calls.some((s) => s.includes("gemma-3-1b"))).toBe(true);
    expect(calls.some((s) => s.includes("Apache-2.0"))).toBe(true);
  });

  it("`pull` without alias prints an error and exits non-zero", async () => {
    const { modelCommand } = await import("./index.js");
    await expect(modelCommand(["pull"], {})).rejects.toThrow(/exit 1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("agentkit model pull"));
  });

  it("rejects unknown subcommands", async () => {
    const { modelCommand } = await import("./index.js");
    await expect(modelCommand(["whatever"], {})).rejects.toThrow(/exit 1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown model subcommand")
    );
  });
});

// ── goalCommand ──────────────────────────────────────────────────────────────

describe("goalCommand", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error(`__exit_${_code}`);
    }) as never);
    originalExitCode = process.exitCode;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAgentEvents = [];
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = originalExitCode;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("requires a task", async () => {
    const { goalCommand } = await import("./index.js");
    await expect(goalCommand("", { workspace: "." })).rejects.toThrow(/__exit_1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("no task provided"));
  });

  it("requires an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { goalCommand } = await import("./index.js");
    await expect(goalCommand("write a doc", { workspace: "." })).rejects.toThrow(/__exit_1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ANTHROPIC_API_KEY")
    );
  });

  it("rejects out-of-range --max-iterations", async () => {
    const { goalCommand } = await import("./index.js");
    await expect(
      goalCommand("write a doc", { workspace: ".", "max-iterations": "0" })
    ).rejects.toThrow(/__exit_1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--max-iterations must be a whole number between 1 and 20")
    );
  });

  it("prints scout/criteria/iter/done events as a timeline by default", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        timestampMs: 0,
        channel: "status",
        event: "scout_done" as never,
        data: { toolCount: 2, workspaceEntries: ["a.md", "b.md"] } as never,
      },
      {
        traceId: "t2",
        parentTraceId: null,
        timestampMs: 1,
        channel: "status",
        event: "criteria_proposed" as never,
        data: {
          criteria: [
            {
              id: "size",
              description: "≥1500 bytes",
              verify_method: "file_size_min",
              arg: 1500,
              path: "doc.md",
            },
          ],
        } as never,
      },
      {
        traceId: "t3",
        parentTraceId: null,
        timestampMs: 2,
        channel: "status",
        event: "goal_iteration_start" as never,
        data: { iteration: 1 } as never,
      },
      {
        traceId: "t4",
        parentTraceId: null,
        timestampMs: 3,
        channel: "status",
        event: "goal_directed_done" as never,
        data: {
          outcome: "verified",
          iterationCount: 1,
          totalInputTokens: 100,
          totalOutputTokens: 200,
        } as never,
      },
    ];
    const { goalCommand } = await import("./index.js");
    await goalCommand("write a small doc", {
      workspace: ".",
      "max-iterations": "3",
      "judge-samples": "3",
    });
    const all = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(all).toMatch(/\[scout]\s+tools=2/);
    expect(all).toMatch(/\[criteria]\s+1 criterion/);
    expect(all).toMatch(/file_size_min=1500/);
    expect(all).toMatch(/\[iter 1]/);
    expect(all).toMatch(/Outcome:\s+verified/);
    expect(process.exitCode).toBe(0);
  });

  it("sets exit code 2 when outcome is exhausted", async () => {
    mockAgentEvents = [
      {
        traceId: "t",
        parentTraceId: null,
        timestampMs: 0,
        channel: "status",
        event: "goal_directed_done" as never,
        data: {
          outcome: "exhausted",
          iterationCount: 5,
          totalInputTokens: 2000,
          totalOutputTokens: 3000,
          lastHint: "doc too short",
        } as never,
      },
    ];
    const { goalCommand } = await import("./index.js");
    await goalCommand("write a doc", { workspace: "." });
    expect(process.exitCode).toBe(2);
  });
});

// ── verifyCommand ────────────────────────────────────────────────────────────

describe("verifyCommand", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;
  let tmpDir = "";

  beforeEach(async () => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    originalExitCode = process.exitCode;
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentkit-verify-test-"));
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = originalExitCode;
    if (tmpDir) {
      const fs = await import("node:fs/promises");
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("requires --criteria flag", async () => {
    const { verifyCommand } = await import("./index.js");
    await expect(verifyCommand({ workspace: "." })).rejects.toThrow(/__exit_1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--criteria"));
  });

  it("rejects unreadable / non-JSON criteria files", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const bad = path.join(tmpDir, "bad.json");
    await fs.writeFile(bad, "not json", "utf8");
    const { verifyCommand } = await import("./index.js");
    await expect(verifyCommand({ criteria: bad, workspace: tmpDir })).rejects.toThrow(/__exit_1/);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
  });

  it("passes when all deterministic criteria are met", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(tmpDir, "doc.md"), "x".repeat(200), "utf8");
    const criteriaPath = path.join(tmpDir, "criteria.json");
    await fs.writeFile(
      criteriaPath,
      JSON.stringify({
        criteria: [
          { id: "exists", description: "doc.md exists", verify_method: "file_exists", path: "doc.md" },
          {
            id: "size",
            description: "≥100 bytes",
            verify_method: "file_size_min",
            arg: 100,
            path: "doc.md",
          },
        ],
      }),
      "utf8"
    );
    const { verifyCommand } = await import("./index.js");
    await verifyCommand({ criteria: criteriaPath, workspace: tmpDir });
    expect(process.exitCode).toBe(0);
    const all = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(all).toMatch(/all 2 criterion/);
  });

  it("fails with exit 1 when any deterministic criterion fails", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const criteriaPath = path.join(tmpDir, "criteria.json");
    await fs.writeFile(
      criteriaPath,
      JSON.stringify([
        { id: "exists", description: "doc.md exists", verify_method: "file_exists", path: "doc.md" },
      ]),
      "utf8"
    );
    const { verifyCommand } = await import("./index.js");
    await verifyCommand({ criteria: criteriaPath, workspace: tmpDir });
    expect(process.exitCode).toBe(1);
  });

  it("skips llm_judge criteria with a stderr notice", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(tmpDir, "doc.md"), "ok", "utf8");
    const criteriaPath = path.join(tmpDir, "criteria.json");
    await fs.writeFile(
      criteriaPath,
      JSON.stringify({
        criteria: [
          { id: "exists", description: "x", verify_method: "file_exists", path: "doc.md" },
          { id: "judge", description: "subjective", verify_method: "llm_judge", path: "doc.md" },
        ],
      }),
      "utf8"
    );
    const { verifyCommand } = await import("./index.js");
    await verifyCommand({ criteria: criteriaPath, workspace: tmpDir });
    expect(process.exitCode).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping 1 llm_judge")
    );
  });
});
