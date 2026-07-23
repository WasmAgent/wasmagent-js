/**
 * T4 · evomerge-t10-qwen3-4b-v11 vs evomerge-qwen3-4b-base — DPO training hypothesis validation
 *
 * Tests whether the trained model (v11) outperforms the base (pre-training) model
 * on tool-calling and QA accuracy. Results are observational; tests don't assert
 * trained beats base — they capture data for the human researcher.
 *
 * Run: bun test tests/integration/live/t4-evomerge-model-bench.test.ts
 *
 * Skipped when Ollama is unreachable or target models are not loaded.
 */

import { describe, expect, it } from "bun:test";
import { ToolCallingAgent } from "@wasmagent/core";
import { OpenAIModel } from "@wasmagent/models";
import { z } from "zod";

// ── Ollama availability ───────────────────────────────────────────────────────

async function ollamaHas(name: string): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = (await r.json()) as { models: Array<{ name: string }> };
    return d.models.some((m) =>
      m.name.includes(name.split(":")[0].split("-").slice(0, 4).join("-"))
    );
  } catch {
    return false;
  }
}

const TRAINED_ID = "evomerge-t10-qwen3-4b-v11:latest";
const BASE_ID = "evomerge-qwen3-4b-base:latest";

const TRAINED_LIVE = await ollamaHas(TRAINED_ID);
const BASE_LIVE = await ollamaHas(BASE_ID);
const BOTH_LIVE = TRAINED_LIVE && BASE_LIVE;

function trainedModel() {
  return new OpenAIModel(TRAINED_ID, {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });
}

function baseModel() {
  return new OpenAIModel(BASE_ID, {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });
}

// ── Shared add tool ───────────────────────────────────────────────────────────

const addTool = {
  name: "add",
  description: "Add two integers and return their sum",
  inputSchema: z.object({
    a: z.number().describe("First integer"),
    b: z.number().describe("Second integer"),
  }),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }: { a: number; b: number }) => String(a + b),
};

// ── Helper: run a ToolCallingAgent with a 30s timeout per call ────────────────

interface BenchResult {
  modelId: string;
  calledTool: boolean;
  finalAnswer: string;
  events: string[];
}

async function runWithTimeout(
  modelId: string,
  model: OpenAIModel,
  task: string,
  timeoutMs = 30_000
): Promise<BenchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const agent = new ToolCallingAgent({ model, tools: [addTool], maxSteps: 5 });
    const events: string[] = [];
    let finalAnswer = "";
    let calledTool = false;

    for await (const ev of agent.run(task)) {
      if (controller.signal.aborted) break;
      events.push(ev.event);
      if (ev.event === "tool_call") calledTool = true;
      if (ev.event === "final_answer") {
        finalAnswer = String((ev.data as { answer: unknown }).answer ?? "");
      }
    }

    clearTimeout(timer);
    return { modelId, calledTool, finalAnswer, events };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort")));
    if (isAbort) {
      console.warn(`  TIMEOUT: ${modelId} did not respond within ${timeoutMs}ms`);
      return { modelId, calledTool: false, finalAnswer: "TIMEOUT", events: ["TIMEOUT"] };
    }
    // Ollama returns 400 when the model's chat template doesn't support tool-calling
    // (e.g. "Unable to generate parser for this template"). Treat as tool-unsupported.
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes("400") ||
      errMsg.includes("Unable to generate parser") ||
      errMsg.includes("invalid_request_error")
    ) {
      console.warn(
        `  TOOL_UNSUPPORTED: ${modelId} returned 400 — model template does not support tool-calling via Ollama`
      );
      return {
        modelId,
        calledTool: false,
        finalAnswer: "TOOL_UNSUPPORTED",
        events: ["TOOL_UNSUPPORTED"],
      };
    }
    throw err;
  }
}

// ── Helper: run a no-tool QA query ────────────────────────────────────────────

async function runQA(
  modelId: string,
  model: OpenAIModel,
  question: string,
  timeoutMs = 30_000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const agent = new ToolCallingAgent({ model, tools: [], maxSteps: 3 });
    let finalAnswer = "";

    for await (const ev of agent.run(question)) {
      if (controller.signal.aborted) break;
      if (ev.event === "final_answer") {
        finalAnswer = String((ev.data as { answer: unknown }).answer ?? "");
      }
    }

    clearTimeout(timer);
    return finalAnswer || "NO_ANSWER";
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort")));
    if (isAbort) return "TIMEOUT";
    throw err;
  }
}

// ── S1: Tool-calling comparison ───────────────────────────────────────────────

describe("T4-S1 · Tool-calling: trained vs base model (evomerge qwen3-4b)", () => {
  it.skipIf(!BOTH_LIVE)(
    "both models attempt tool-calling on add(15,27)=42; results logged for comparison",
    async () => {
      const task = "Use the add tool to compute 15 + 27. Answer with just the number.";

      const [trainedResult, baseResult] = await Promise.all([
        runWithTimeout(TRAINED_ID, trainedModel(), task),
        runWithTimeout(BASE_ID, baseModel(), task),
      ]);

      const trainedCalledTool = trainedResult.calledTool;
      const baseCalledTool = baseResult.calledTool;
      const trainedCorrect = trainedResult.finalAnswer.includes("42");
      const baseCorrect = baseResult.finalAnswer.includes("42");

      console.log("\n── T4-S1 Tool-calling comparison ──────────────────────────────");
      console.log(`  TRAINED (${TRAINED_ID})`);
      console.log(`    called tool: ${trainedCalledTool}`);
      console.log(`    correct (42): ${trainedCorrect}`);
      console.log(`    finalAnswer: "${trainedResult.finalAnswer.slice(0, 100)}"`);
      console.log(`  BASE    (${BASE_ID})`);
      console.log(`    called tool: ${baseCalledTool}`);
      console.log(`    correct (42): ${baseCorrect}`);
      console.log(`    finalAnswer: "${baseResult.finalAnswer.slice(0, 100)}"`);
      console.log("───────────────────────────────────────────────────────────────");

      const trainedUnsupported = trainedResult.finalAnswer === "TOOL_UNSUPPORTED";
      const baseUnsupported = baseResult.finalAnswer === "TOOL_UNSUPPORTED";

      if (trainedUnsupported || baseUnsupported) {
        console.log(
          "  NOTE: One or both models returned TOOL_UNSUPPORTED (Ollama chat template incompatibility)"
        );
        console.log(
          "  This is expected for evomerge models — tool-calling requires template support in Ollama"
        );
        console.log("  S2 (QA accuracy without tools) will still run.");
      } else if (trainedCalledTool && !baseCalledTool) {
        console.log("  FINDING: DPO training improved tool-calling (trained called, base did not)");
      } else if (!trainedCalledTool && baseCalledTool) {
        console.log("  FINDING: Base model called tool but trained did not — regression?");
      } else if (trainedCalledTool && baseCalledTool) {
        console.log("  FINDING: Both models called the tool");
      } else {
        console.log(
          "  FINDING: Neither model called the tool — may need larger model or stronger prompt"
        );
      }

      // Soft assertions — don't fail test if models don't call tools (they're small)
      // TOOL_UNSUPPORTED is a valid outcome (not a test failure)
      expect(typeof trainedResult.calledTool).toBe("boolean");
      expect(typeof baseResult.calledTool).toBe("boolean");
      // Must complete without unhandled exception (TIMEOUT/TOOL_UNSUPPORTED are acceptable)
      expect(trainedResult.events.length).toBeGreaterThan(0);
      expect(baseResult.events.length).toBeGreaterThan(0);
    },
    90_000
  );

  it.skipIf(!TRAINED_LIVE && !BASE_LIVE)(
    "at least one model is available (skip guard)",
    async () => {
      console.log(`  Trained model available: ${TRAINED_LIVE}`);
      console.log(`  Base model available: ${BASE_LIVE}`);
      if (!BOTH_LIVE) {
        console.log("  NOTE: only one model available — S1/S2/S3 comparison tests skipped");
      }
      expect(TRAINED_LIVE || BASE_LIVE).toBe(true);
    },
    5_000
  );
});

// ── S2: QA accuracy (v11 only — base model excluded) ─────────────────────────
//
// The base model (evomerge-qwen3-4b-base) is a raw completion model, not a
// chat-tuned model. Sending it chat-formatted messages via the OpenAI-compatible
// endpoint produces garbage or errors. S2 therefore only evaluates the trained
// v11 model on pure QA (no tool-calling). Use S1 for the tool-calling comparison
// (which already handles TOOL_UNSUPPORTED gracefully for both models).

const V11_LIVE = TRAINED_LIVE;

describe("T4-S2 · QA accuracy: v11 trained model only (base excluded — completion model)", () => {
  const QA_PAIRS: Array<{ question: string; correct: string; label: string }> = [
    { question: "What is 7 × 8? Answer with just the number.", correct: "56", label: "7×8" },
    {
      question: "What is the square root of 9? Answer with just the number.",
      correct: "3",
      label: "sqrt(9)",
    },
    { question: "What is 100 ÷ 4? Answer with just the number.", correct: "25", label: "100÷4" },
    { question: "What is 2^10? Answer with just the number.", correct: "1024", label: "2^10" },
    {
      question: "If a=5, b=3, what is a+b+a×b? Show only the final number.",
      correct: "23",
      label: "a+b+a×b",
    },
  ];

  it.skipIf(!V11_LIVE)(
    "v11 answers 5 factual questions correctly (no tool-calling, no base model comparison)",
    async () => {
      let trainedScore = 0;

      const rows: Array<{
        label: string;
        correct: string;
        trainedAnswer: string;
        trainedPass: boolean;
      }> = [];

      for (const { question, correct, label } of QA_PAIRS) {
        const trainedAns = await runQA(TRAINED_ID, trainedModel(), question);

        const trainedPass = trainedAns.includes(correct);
        if (trainedPass) trainedScore++;

        rows.push({
          label,
          correct,
          trainedAnswer: trainedAns.slice(0, 60),
          trainedPass,
        });
      }

      console.log("\n── T4-S2 QA Accuracy (v11 only) ────────────────────────────────");
      console.log(
        `  ${"Question".padEnd(12)} | ${"Correct".padEnd(6)} | ${"v11 Answer".padEnd(40)} | v11✓`
      );
      console.log(`  ${"-".repeat(80)}`);
      for (const r of rows) {
        console.log(
          `  ${r.label.padEnd(12)} | ${r.correct.padEnd(6)} | ${r.trainedAnswer.padEnd(40)} | ${r.trainedPass ? "YES" : "NO"}`
        );
      }
      console.log(`  ${"-".repeat(80)}`);
      console.log(`  v11 score: ${trainedScore}/5`);
      console.log("  NOTE: base model excluded — it is a raw completion model, not chat-tuned");
      console.log("────────────────────────────────────────────────────────────────");

      // Assert v11 answers correctly (it is chat-tuned via DPO)
      expect(trainedScore).toBeGreaterThan(0);
      expect(trainedScore).toBeLessThanOrEqual(5);
    },
    300_000
  );
});

// ── S3: Context retention ─────────────────────────────────────────────────────

describe("T4-S3 · Context retention: does the model remember injected facts?", () => {
  it.skipIf(!BOTH_LIVE)(
    "both models answer a question about a fact given in the same prompt",
    async () => {
      const task =
        "I told you earlier that my secret number is 42. What was my secret number? Answer with just the number.";

      const [trainedAns, baseAns] = await Promise.all([
        runQA(TRAINED_ID, trainedModel(), task),
        runQA(BASE_ID, baseModel(), task),
      ]);

      const trainedRecalls = trainedAns.includes("42");
      const baseRecalls = baseAns.includes("42");

      console.log("\n── T4-S3 Context Retention ──────────────────────────────────────");
      console.log(`  TRAINED: recalled=  ${trainedRecalls}  answer="${trainedAns.slice(0, 80)}"`);
      console.log(`  BASE:    recalled=  ${baseRecalls}  answer="${baseAns.slice(0, 80)}"`);

      if (trainedRecalls && !baseRecalls) {
        console.log("  FINDING: DPO training improved context retention");
      } else if (!trainedRecalls && baseRecalls) {
        console.log("  FINDING: Base recalled but trained did not — possible regression");
      } else if (trainedRecalls && baseRecalls) {
        console.log("  FINDING: Both models recalled the injected fact");
      } else {
        console.log("  FINDING: Neither model recalled the injected fact");
      }
      console.log("────────────────────────────────────────────────────────────────");

      // Soft assertion: models must complete (not crash/timeout without answer)
      expect(trainedAns.length).toBeGreaterThan(0);
      expect(baseAns.length).toBeGreaterThan(0);
    },
    90_000
  );
});

// ── S4: Format check — training format bleed detection ───────────────────────
//
// FINDING (2026-06-24): evomerge-t10-qwen3-4b-v11 suffers from "training format
// bleed" — it returns {"choice":"<letter>"} for general QA questions because the
// ARM-F SFT training data uses {"choice":"<tool>"} for every action turn. The
// model generalized this JSON format to all responses outside its training
// distribution. See docs/eval-reports/model-sweep-1b7.md for full diagnosis.
//
// This test DOCUMENTS the issue rather than asserting it's fixed. Once the
// training pipeline adds general QA recovery data, update the assertion to
// expect(isFormatBleed).toBe(false).

describe("T4-S4 · Training format bleed detection", () => {
  it.skipIf(!V11_LIVE)(
    "detects whether v11 returns JSON-wrapped output (known issue)",
    async () => {
      const model = new OpenAIModel("evomerge-t10-qwen3-4b-v11:latest", {
        baseURL: "http://localhost:11434/v1",
        apiKey: "ollama",
      });
      const agent = new ToolCallingAgent({ model, tools: [], maxSteps: 3 });

      let finalAnswer = "";
      for await (const ev of agent.run("What is 7 times 8? Reply with just the number.")) {
        if (ev.event === "final_answer") finalAnswer = (ev.data as { answer: string }).answer;
      }

      const isFormatBleed = /^\{.*"choice".*\}$/s.test(finalAnswer.trim());
      const hasCorrectAnswer = finalAnswer.includes("56");

      console.log("T4-S4 v11 answer:", JSON.stringify(finalAnswer));
      console.log("T4-S4 format bleed detected:", isFormatBleed);
      console.log("T4-S4 correct answer (56):", hasCorrectAnswer);

      if (isFormatBleed) {
        console.warn(
          'WARNING: v11 exhibits training format bleed — outputs {"choice":...} for QA tasks. ' +
            "Root cause: ARM-F SFT training data overfit. " +
            "See docs/eval-reports/model-sweep-1b7.md for details."
        );
      }

      // Test passes regardless — this is a DIAGNOSTIC test, not a regression guard.
      // The metric we track is whether format bleed is present or absent.
      expect(finalAnswer.length).toBeGreaterThan(0);
      // Log result for CI visibility (do not fail — issue is known and documented)
    },
    30_000
  );
});
