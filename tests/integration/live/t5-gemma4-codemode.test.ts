/**
 * T5 · gemma4-12b (Ollama) — tool-calling baseline + PTC code-mode + WASM sandbox
 *
 * Real model: gemma4-12b:latest via Ollama at http://localhost:11434
 * Run: bun test tests/integration/live/t5-gemma4-codemode.test.ts
 *
 * Skipped at the suite level when Ollama is unreachable or gemma4-12b is not loaded.
 * S2 and S3 do not require a model at all.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { JsKernel, OpenAIModel, ProgrammaticOrchestrator, ToolCallingAgent, ToolRegistry } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

// ── Ollama availability check ─────────────────────────────────────────────────

async function checkOllamaModel(modelId: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(modelId.split(":")[0]));
  } catch {
    return false;
  }
}

// Resolved once, shared across all scenarios.
const GEMMA_AVAILABLE = await checkOllamaModel("gemma4-12b:latest");

function gemma() {
  return new OpenAIModel("gemma4-12b:latest", {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });
}

// ── Scenario 1: ToolCallingAgent with echo tool ───────────────────────────────

describe("T5-S1 · ToolCallingAgent with gemma4-12b and echo tool", () => {
  it.skipIf(!GEMMA_AVAILABLE)(
    "calls the echo tool and returns non-empty finalAnswer",
    async () => {
      const echoCallLog: string[] = [];

      const echoTool = {
        name: "echo",
        description: "Echo a message back",
        inputSchema: z.object({
          message: z.string().describe("The message to echo"),
        }),
        readOnly: true,
        idempotent: true,
        forward: async ({ message }: { message: string }) => {
          echoCallLog.push(message);
          return message;
        },
      };

      const agent = new ToolCallingAgent({
        model: gemma(),
        tools: [echoTool],
        maxSteps: 5,
      });

      const trajectory = [];
      let finalAnswer = "";

      for await (const ev of agent.run("Call the echo tool with message 'hello gemma'")) {
        trajectory.push(ev);
        if (ev.event === "final_answer") {
          finalAnswer = String((ev.data as { answer: unknown }).answer ?? "");
        }
      }

      const eventNames = trajectory.map((e) => e.event);

      // Agent must complete without throwing
      expect(eventNames).toContain("run_start");
      expect(finalAnswer.length).toBeGreaterThan(0);

      // toolCallSequence on the run context — at least one tool_call event emitted
      const toolCallEvents = trajectory.filter((e) => e.event === "tool_call");
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);

      console.log("T5-S1 finalAnswer:", finalAnswer.slice(0, 80));
      console.log("T5-S1 echoCallLog:", echoCallLog);
    },
    90_000
  );
});

// ── Scenario 2: ProgrammaticOrchestrator + JsKernel ──────────────────────────
// This scenario does not require a model. It verifies PO executes scripts and
// dispatches tool calls through the ToolRegistry correctly.

describe("T5-S2 · ProgrammaticOrchestrator + JsKernel with calc tool", () => {
  it("executes a pre-written script and returns the correct tool output", async () => {
    const calcTool = {
      name: "calc",
      description: "Add two numbers",
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      readOnly: true,
      idempotent: true,
      forward: async ({ a, b }: { a: number; b: number }) => String(a + b),
    };

    const registry = new ToolRegistry();
    registry.register(calcTool);

    const kernel = new JsKernel();
    const po = new ProgrammaticOrchestrator(kernel, registry, {});

    // Script uses callTool() injected by ProgrammaticOrchestrator's prelude.
    // Must use `return` so the async IIFE captures the final value.
    const { finalOutput, toolCallCount } = await po.run(
      "const result = await callTool('calc', { a: 3, b: 4 }); return result;"
    );

    console.log("T5-S2 finalOutput:", finalOutput);
    console.log("T5-S2 toolCallCount:", toolCallCount);

    // 3 + 4 = 7
    expect(finalOutput).toContain("7");
    expect(toolCallCount).toBe(1);
  }, 30_000);
});

// ── Scenario 3: QuickJSKernel WASM isolation ──────────────────────────────────
// No model needed. Verifies that Node.js globals are absent in the QuickJS sandbox.

describe("T5-S3 · QuickJSKernel WASM sandbox isolation", () => {
  it("reports 'undefined' for typeof process inside QuickJS", async () => {
    const kernel = new QuickJSKernel();

    const result = await kernel.run("typeof process", { allowedHosts: [] });

    console.log("T5-S3 QuickJS typeof process:", result.output);

    // In QuickJS there is no Node.js process global — typeof returns "undefined".
    // KernelResult.output is the raw evaluated value (a string), not JSON-stringified.
    expect(result.output).toBe("undefined");
  }, 15_000);
});
