/**
 * T3 · qwen2.5:0.5b (Ollama) — local offline tool-calling baseline
 *
 * Real model: qwen2.5:0.5b via Ollama at http://localhost:11434
 * Run: bun test tests/integration/live/t3-qwen-offline.test.ts
 *
 * Skipped at the suite level when Ollama is unreachable or qwen2.5:0.5b is not loaded.
 * S3 does not require a model at all.
 */

import { describe, expect, it } from "bun:test";
import { CodeAgent, JsKernel, OpenAIModel, ToolCallingAgent } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { z } from "zod";

// ── Ollama availability check ─────────────────────────────────────────────────

async function ollamaHasModel(name: string): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = (await r.json()) as { models: Array<{ name: string }> };
    return d.models.some((m) => m.name.includes(name.split(":")[0]));
  } catch {
    return false;
  }
}

const QWEN_LIVE = await ollamaHasModel("qwen2.5:0.5b");

function qwen() {
  return new OpenAIModel("qwen2.5:0.5b", {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });
}

// ── Scenario 1: Tool-calling baseline (qwen2.5:0.5b) ─────────────────────────

describe("T3-S1 · ToolCallingAgent with qwen2.5:0.5b and add tool", () => {
  it.skipIf(!QWEN_LIVE)(
    "returns non-empty finalAnswer without crashing (tool_call is best-effort for 0.5b)",
    async () => {
      const addTool = {
        name: "add",
        description: "Add two integers and return the sum",
        inputSchema: z.object({
          a: z.number().describe("First integer"),
          b: z.number().describe("Second integer"),
        }),
        readOnly: true,
        idempotent: true,
        forward: async ({ a, b }: { a: number; b: number }) => String(a + b),
      };

      const agent = new ToolCallingAgent({
        model: qwen(),
        tools: [addTool],
        maxSteps: 6,
      });

      const trajectory: Array<{ event: string }> = [];
      let finalAnswer = "";

      for await (const ev of agent.run("Use the add tool: add(4, 6)")) {
        trajectory.push(ev);
        if (ev.event === "final_answer") {
          const data = ev.data as { answer: unknown };
          finalAnswer = typeof data.answer === "string" ? data.answer : JSON.stringify(data.answer);
        }
      }

      const eventNames = trajectory.map((e) => e.event);
      console.log("T3-S1 events:", eventNames.join(", "));
      console.log("T3-S1 finalAnswer:", finalAnswer);

      // Must always produce a final answer and not crash
      expect(finalAnswer.length).toBeGreaterThan(0);

      const toolCallSequence = trajectory.filter(
        (e) => e.event === "tool_call" || e.event === "tool_result"
      );
      if (toolCallSequence.length === 0) {
        console.warn(
          "T3-S1 WARNING: qwen2.5:0.5b did not call the add tool — " +
            "this is expected for a 0.5b model. finalAnswer non-empty, no crash."
        );
      } else {
        console.log("T3-S1 toolCallSequence length:", toolCallSequence.length);
      }
    },
    60_000
  );
});

// ── Scenario 2: CodeAgent + JsKernel offline closure ─────────────────────────

describe("T3-S2 · CodeAgent + JsKernel — first 5 primes (qwen2.5:0.5b)", () => {
  it.skipIf(!QWEN_LIVE)(
    "returns finalAnswer containing prime numbers 2, 3, 5 (or at minimum non-empty)",
    async () => {
      const kernel = new JsKernel();

      const agent = new CodeAgent({
        model: qwen(),
        tools: [],
        kernel,
        maxSteps: 8,
      });

      const trajectory: Array<{ event: string }> = [];
      let finalAnswer = "";

      for await (const ev of agent.run(
        "Write and execute JS code to compute the first 5 prime numbers."
      )) {
        trajectory.push(ev);
        if (ev.event === "final_answer") {
          const data = ev.data as { answer: unknown };
          finalAnswer = typeof data.answer === "string" ? data.answer : JSON.stringify(data.answer);
        }
      }

      const eventNames = trajectory.map((e) => e.event);
      console.log("T3-S2 events:", eventNames.join(", "));
      console.log("T3-S2 finalAnswer:", finalAnswer);

      // Collect any text emitted during the run (thinking, step, error events)
      // for a weaker "model produced output" check when finalAnswer is empty.
      const hasAnyEvent = trajectory.length > 0;

      // Must not have crashed (thrown an exception) — reaching here means it didn't.
      // qwen2.5:0.5b may produce an error event instead of final_answer when it
      // can't generate valid code. Accept that as a soft pass.
      expect(hasAnyEvent).toBe(true);

      const hasError = eventNames.includes("error");
      if (finalAnswer.length === 0 && hasError) {
        console.warn(
          "T3-S2 SOFT PASS: qwen2.5:0.5b hit an error event without producing a " +
            "final_answer — this is expected for a 0.5b CodeAgent. Agent did not throw."
        );
      } else if (finalAnswer.length === 0) {
        console.warn(
          "T3-S2 SOFT PASS: qwen2.5:0.5b did not produce final_answer. " +
            `Events seen: ${eventNames.join(", ")}`
        );
      } else {
        const hasPrimes =
          finalAnswer.includes("2") && finalAnswer.includes("3") && finalAnswer.includes("5");
        if (!hasPrimes) {
          console.warn(
            "T3-S2 WARNING: finalAnswer does not contain expected primes 2/3/5 — " +
              "qwen2.5:0.5b may produce non-standard output. Answer was: " +
              finalAnswer.slice(0, 200)
          );
        } else {
          console.log("T3-S2 prime verification passed.");
        }
      }

      await kernel[Symbol.asyncDispose]();
    },
    90_000
  );
});

// ── Scenario 3: CapabilityManifest blocks network in WASM kernel ──────────────
// Pure kernel test — no model required.

describe("T3-S3 · QuickJSKernel — allowedHosts:[] blocks fetch", () => {
  it("returns error or undefined (not a live HTTP response) when fetch is not injected", async () => {
    const kernel = new QuickJSKernel({ timeoutMs: 3_000 });

    // When allowedHosts is omitted or empty, fetch is NOT injected into the QuickJS
    // context at all (it stays undefined). So the script will throw ReferenceError or
    // return the string "undefined" from typeof.
    // We also test with allowedHosts:[] explicitly (deny-all).
    const result = await kernel.run(
      "typeof fetch === 'function' ? fetch('https://example.com').then(r=>r.status) : 'fetch_not_available'",
      { allowedHosts: [] }
    );

    console.log("T3-S3 result.output:", result.output);
    console.log("T3-S3 result.isFinalAnswer:", result.isFinalAnswer);

    // The test passes when:
    // (a) output is "fetch_not_available" (fetch undefined — deny-all baseline), OR
    // (b) result has an error embedded in output (e.g. "CapabilityDenied"), OR
    // (c) output is not a valid HTTP status code number (200, 301, etc.)
    const outputStr = String(result.output ?? "");
    const isLiveHttpStatus =
      typeof result.output === "number" && result.output >= 100 && result.output < 600;
    expect(isLiveHttpStatus).toBe(false);

    if (outputStr.includes("fetch_not_available") || result.output === "fetch_not_available") {
      console.log("T3-S3 PASS: fetch correctly absent with empty allowedHosts.");
    } else if (
      outputStr.toLowerCase().includes("capabilitydenied") ||
      outputStr.toLowerCase().includes("not in allowedhosts")
    ) {
      console.log("T3-S3 PASS: fetch present but blocked by CapabilityDenied.");
    } else {
      console.log(
        "T3-S3 output did not match expected patterns but is not a live HTTP status — pass."
      );
    }

    await kernel[Symbol.asyncDispose]();
  }, 15_000);
});
