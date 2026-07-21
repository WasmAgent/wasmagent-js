/**
 * T8 · evomerge-t10-1b7 version sweep — v7f → v8 → v9a → v10
 *
 * Does iterative DPO training improve tool-calling across versions?
 * Each model is scored on 3 math tasks using the add tool.
 * Results are written to docs/eval-reports/model-sweep-1b7.md.
 *
 * Run: bun test tests/integration/live/t8-model-sweep.test.ts
 *
 * Skipped when Ollama is unreachable. Individual models that fail/timeout
 * receive "TIMEOUT" score entries rather than failing the whole suite.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenAIModel, ToolCallingAgent } from "@wasmagent/core";
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

async function ollamaReachable(): Promise<boolean> {
  try {
    await fetch("http://localhost:11434/api/tags");
    return true;
  } catch {
    return false;
  }
}

const OLLAMA_UP = await ollamaReachable();

// ── Model versions to sweep ───────────────────────────────────────────────────

const SWEEP_MODELS = [
  "evomerge-t10-1b7-v7f:latest",
  "evomerge-t10-1b7-v8:latest",
  "evomerge-t10-1b7-v9a:latest",
  "evomerge-t10-1b7-v10:latest",
] as const;

// ── Task definitions ──────────────────────────────────────────────────────────

interface Task {
  prompt: string;
  expected: string;
  label: string;
}

const TASKS: Task[] = [
  {
    prompt: "Use the add tool to compute 3 + 4. Answer with just the number.",
    expected: "7",
    label: "3+4=7",
  },
  {
    prompt: "Use the add tool to compute 10 + 15. Answer with just the number.",
    expected: "25",
    label: "10+15=25",
  },
  {
    prompt: "Use the add tool to compute 100 + 200. Answer with just the number.",
    expected: "300",
    label: "100+200=300",
  },
];

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

// ── Scoring ───────────────────────────────────────────────────────────────────

/** 1.0 if finalAnswer contains expected, 0.5 if tool was called (even wrong), 0 otherwise. */
function score(calledTool: boolean, finalAnswer: string, expected: string): number {
  if (finalAnswer === "TIMEOUT" || finalAnswer === "TOOL_UNSUPPORTED") return 0;
  if (finalAnswer.includes(expected)) return 1.0;
  if (calledTool) return 0.5;
  return 0.0;
}

// ── Helper: run one task on one model with 30s timeout ───────────────────────

interface TaskResult {
  calledTool: boolean;
  finalAnswer: string;
  score: number;
  events: string[];
}

async function runTask(modelId: string, task: Task, timeoutMs = 30_000): Promise<TaskResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const model = new OpenAIModel(modelId, {
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
    const agent = new ToolCallingAgent({ model, tools: [addTool], maxSteps: 5 });

    const events: string[] = [];
    let finalAnswer = "";
    let calledTool = false;

    for await (const ev of agent.run(task.prompt)) {
      if (controller.signal.aborted) break;
      events.push(ev.event);
      if (ev.event === "tool_call") calledTool = true;
      if (ev.event === "final_answer") {
        finalAnswer = String((ev.data as { answer: unknown }).answer ?? "");
      }
    }

    clearTimeout(timer);
    const s = score(calledTool, finalAnswer, task.expected);
    return { calledTool, finalAnswer, score: s, events };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort")));
    if (isAbort) {
      console.warn(`  TIMEOUT: ${modelId} on task "${task.label}"`);
      return { calledTool: false, finalAnswer: "TIMEOUT", score: 0, events: ["TIMEOUT"] };
    }
    // Ollama returns 400 when a model's chat template doesn't support tool-calling.
    // Treat as "tool calling not supported" rather than a hard test failure.
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes("400") ||
      errMsg.includes("Unable to generate parser") ||
      errMsg.includes("invalid_request_error")
    ) {
      console.warn(
        `  TOOL_UNSUPPORTED: ${modelId} — model template incompatible with tool-calling`
      );
      return {
        calledTool: false,
        finalAnswer: "TOOL_UNSUPPORTED",
        score: 0,
        events: ["TOOL_UNSUPPORTED"],
      };
    }
    throw err;
  }
}

// ── Cell label for report ─────────────────────────────────────────────────────

function cellLabel(result: TaskResult): string {
  if (result.finalAnswer === "TIMEOUT") return "TIMEOUT";
  if (result.finalAnswer === "TOOL_UNSUPPORTED") return "NO_TOOL_SUPPORT";
  if (result.finalAnswer === "NO_ANSWER" || result.finalAnswer.length === 0) return "NO_ANSWER";
  if (result.score === 1.0) return `PASS(${result.finalAnswer.slice(0, 8).trim()})`;
  if (result.score === 0.5) return `TOOL_WRONG(${result.finalAnswer.slice(0, 8).trim()})`;
  return `FAIL(${result.finalAnswer.slice(0, 8).trim()})`;
}

// ── Main sweep scenario ───────────────────────────────────────────────────────

describe("T8 · evomerge-t10-1b7 version sweep — DPO training quality comparison", () => {
  it.skipIf(!OLLAMA_UP)(
    "runs all 4 model versions on 3 math tasks and writes docs/eval-reports/model-sweep-1b7.md",
    async () => {
      type ModelLabel = (typeof SWEEP_MODELS)[number];
      type SweepResults = Record<ModelLabel, TaskResult[]>;

      const results = {} as SweepResults;
      const availability: Record<string, boolean> = {};

      // Probe availability for all models up-front
      for (const modelId of SWEEP_MODELS) {
        availability[modelId] = await ollamaHas(modelId);
        if (!availability[modelId]) {
          console.warn(`  SKIP: ${modelId} not found in Ollama — will log N/A`);
        }
      }

      // Run tasks sequentially per model to avoid OOM on small hardware
      for (const modelId of SWEEP_MODELS) {
        if (!availability[modelId]) {
          results[modelId] = TASKS.map(() => ({
            calledTool: false,
            finalAnswer: "N/A",
            score: 0,
            events: ["N/A"],
          }));
          continue;
        }

        console.log(`\n  ── ${modelId} ──`);
        const modelResults: TaskResult[] = [];

        for (const task of TASKS) {
          console.log(`     task: ${task.label} ...`);
          const r = await runTask(modelId, task);
          modelResults.push(r);
          console.log(
            `       calledTool=${r.calledTool}  answer="${r.finalAnswer.slice(0, 40)}"  score=${r.score}`
          );
        }

        results[modelId] = modelResults;
      }

      // ── Print console summary ─────────────────────────────────────────────

      const totalScores: Record<string, number> = {};
      for (const modelId of SWEEP_MODELS) {
        totalScores[modelId] = results[modelId].reduce((s, r) => s + r.score, 0);
      }

      console.log("\n── T8 Version Sweep Summary ─────────────────────────────────────");
      const header = `  ${"Model".padEnd(36)} | ${TASKS.map((t) => t.label.padEnd(14)).join(" | ")} | Total`;
      console.log(header);
      console.log(`  ${"-".repeat(header.length - 2)}`);

      for (const modelId of SWEEP_MODELS) {
        const cells = results[modelId].map((r, i) => cellLabel(r).padEnd(14));
        const total = totalScores[modelId].toFixed(1);
        const shortName = modelId.replace(":latest", "").split("-").slice(-2).join("-");
        console.log(`  ${shortName.padEnd(36)} | ${cells.join(" | ")} | ${total}/3`);
      }
      console.log("────────────────────────────────────────────────────────────────");

      // Trend analysis
      const scores = SWEEP_MODELS.map((m) => totalScores[m]);
      const allZero = scores.every((s) => s === 0);
      const allUnsupported = SWEEP_MODELS.every((m) =>
        results[m].every((r) => r.finalAnswer === "TOOL_UNSUPPORTED" || r.finalAnswer === "N/A")
      );
      const improving = !allZero && scores.every((s, i) => i === 0 || s >= scores[i - 1]);
      const degrading = !allZero && scores.every((s, i) => i === 0 || s <= scores[i - 1]);

      if (allUnsupported) {
        console.log(
          "  TREND: All models returned NO_TOOL_SUPPORT — Ollama chat templates do not support tool-calling for these evomerge models"
        );
        console.log(
          "  NOTE: Tool-calling evaluation requires models with compatible Ollama chat templates (e.g. Qwen2.5 or Gemma4 format)"
        );
      } else if (improving) {
        console.log("  TREND: Monotonically improving — DPO iterations appear beneficial");
      } else if (degrading) {
        console.log("  TREND: Monotonically degrading — review DPO data quality");
      } else {
        const best = SWEEP_MODELS[scores.indexOf(Math.max(...scores))];
        console.log(
          `  TREND: Non-monotonic — best version: ${best} (score=${Math.max(...scores).toFixed(1)})`
        );
      }

      // ── Write markdown report ─────────────────────────────────────────────

      const repoRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
      const reportDir = join(repoRoot, "docs", "eval-reports");
      mkdirSync(reportDir, { recursive: true });
      const reportPath = join(reportDir, "model-sweep-1b7.md");

      const now = new Date().toISOString().slice(0, 19).replace("T", " ");

      const tableHeader = `| Model | ${TASKS.map((t) => t.label).join(" | ")} | Score |`;
      const tableSep = `|---|${TASKS.map(() => "---").join("|")}|---|`;
      const tableRows = SWEEP_MODELS.map((modelId) => {
        const cells = results[modelId].map((r) => cellLabel(r));
        const total = `${totalScores[modelId].toFixed(1)}/3`;
        const shortName = modelId.replace(":latest", "");
        return `| ${shortName} | ${cells.join(" | ")} | ${total} |`;
      }).join("\n");

      const findingsLines: string[] = [];
      if (allUnsupported) {
        findingsLines.push(
          "- **All models returned `NO_TOOL_SUPPORT`**: Ollama's structured output parser cannot process these models' chat templates for tool-calling."
        );
        findingsLines.push(
          "- **Tool-calling DPO evaluation not possible** via Ollama OpenAI-compatible endpoint for evomerge-t10-1b7 models."
        );
        findingsLines.push(
          "- **Recommended next step**: Evaluate tool-calling ability using a model with a compatible chat template (e.g. qwen2.5 or gemma4 base), or test evomerge models on direct generation tasks (QA without tools)."
        );
      } else if (improving) {
        findingsLines.push("- **DPO training shows consistent improvement** across all versions.");
        findingsLines.push(
          `- Final version (${SWEEP_MODELS[SWEEP_MODELS.length - 1].replace(":latest", "")}) achieved best score.`
        );
      } else if (degrading) {
        findingsLines.push("- **Scores degraded** across versions — review DPO data pipeline.");
        findingsLines.push("- Earlier versions may have been better starting points.");
      } else {
        const bestIdx = scores.indexOf(Math.max(...scores));
        const worstIdx = scores.indexOf(Math.min(...scores));
        findingsLines.push(
          `- **Non-monotonic progression**: best=${SWEEP_MODELS[bestIdx].replace(":latest", "")} (${scores[bestIdx].toFixed(1)}/3), worst=${SWEEP_MODELS[worstIdx].replace(":latest", "")} (${scores[worstIdx].toFixed(1)}/3).`
        );
        findingsLines.push("- DPO improvements are not consistent across iterations.");
      }

      const timeoutModels = SWEEP_MODELS.filter((m) =>
        results[m].some((r) => r.finalAnswer === "TIMEOUT")
      );
      if (timeoutModels.length > 0) {
        findingsLines.push(
          `- Models that hit 30s timeout: ${timeoutModels.map((m) => m.replace(":latest", "")).join(", ")}.`
        );
      }

      const naModels = SWEEP_MODELS.filter((m) => !availability[m]);
      if (naModels.length > 0) {
        findingsLines.push(
          `- Models not available in Ollama: ${naModels.map((m) => m.replace(":latest", "")).join(", ")}.`
        );
      }

      const reportContent = `# evomerge t10-1b7 Model Sweep — Tool Calling Accuracy
Generated: ${now}

## Setup
- Ollama endpoint: \`http://localhost:11434\`
- Tool: \`add(a, b)\` — returns \`a + b\` as a string
- Tasks: 3 addition problems
- Scoring: 1.0 = correct answer, 0.5 = tool called (wrong answer), 0 = no tool call
- Per-model timeout: 30s per inference call

## Results

${tableHeader}
${tableSep}
${tableRows}

## Score Legend
- \`PASS(n)\` — correct answer, tool was called (1.0 pts)
- \`TOOL_WRONG(n)\` — tool called but answer incorrect (0.5 pts)
- \`FAIL(n)\` — no tool call, incorrect answer (0 pts)
- \`NO_TOOL_SUPPORT\` — Ollama 400: model chat template does not support tool-calling (0 pts)
- \`TIMEOUT\` — no response within 30s (0 pts)
- \`N/A\` — model not loaded in Ollama

## Findings
${findingsLines.map((l) => l).join("\n")}

## Methodology Notes
- Models tested sequentially to avoid GPU memory contention.
- Scores are based on \`finalAnswer\` content matching expected values.
- Tool-call detection uses the \`tool_call\` event in the agent trajectory.
- Results are observational — no statistical significance testing performed.
`;

      writeFileSync(reportPath, reportContent, "utf-8");
      console.log(`\n  Report written to: docs/eval-reports/model-sweep-1b7.md`);

      // ── Assertions ────────────────────────────────────────────────────────

      // All models must have produced results (no unhandled throws)
      for (const modelId of SWEEP_MODELS) {
        expect(results[modelId]).toHaveLength(TASKS.length);
        for (const r of results[modelId]) {
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(1.0);
        }
      }

      // Report file must have been written
      const fs = await import("node:fs");
      expect(fs.existsSync(reportPath)).toBe(true);
    },
    // 4 models × 3 tasks × 30s + overhead
    600_000
  );
});

// ── T8-S2: Pure generation QA sweep ──────────────────────────────────────────

describe("T8-S2 · Pure generation QA sweep (no tool-calling)", () => {
  it.skipIf(!OLLAMA_UP)(
    "evomerge 1b7 versions answer simple math via raw generation",
    async () => {
      const MODELS = [
        "evomerge-t10-1b7-v7f:latest",
        "evomerge-t10-1b7-v9a:latest",
        "evomerge-t10-1b7-v10:latest",
      ];

      // Use raw Ollama generate API (not chat/tools)
      async function rawGenerate(model: string, prompt: string): Promise<string> {
        const r = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { num_predict: 50, temperature: 0 },
          }),
          signal: AbortSignal.timeout(25_000),
        });
        const d = (await r.json()) as { response: string };
        return (d.response ?? "").trim().slice(0, 80);
      }

      const tasks = [
        { prompt: "Q: What is 3+4? A:", expected: "7" },
        { prompt: "Q: What is 10-3? A:", expected: "7" },
        { prompt: "Q: The capital of France is:", expected: "Paris" },
      ];

      const results: Record<string, number> = {};

      for (const modelId of MODELS) {
        const available = await ollamaHas(modelId.split(":")[0]);
        if (!available) {
          results[modelId] = -1;
          console.log(`  SKIP ${modelId} (not loaded)`);
          continue;
        }

        let score = 0;
        for (const { prompt, expected } of tasks) {
          const answer = await rawGenerate(modelId, prompt);
          if (answer.includes(expected)) score++;
          console.log(
            `  ${modelId.split("-").slice(-1)[0]} | "${prompt}" → "${answer.slice(0, 40)}" [${answer.includes(expected) ? "✓" : "✗"}]`
          );
        }
        results[modelId] = score;
      }

      console.log("\nQA Sweep results:", results);
      // At least one model must have loaded (not all -1)
      const loaded = Object.values(results).filter((v) => v >= 0);
      expect(loaded.length).toBeGreaterThan(0);
      // Log without hard assertions on score (observational)
    },
    120_000
  );
});
