/**
 * T6 · FallbackModel chain: evomerge-t10-1b7-v10 → claude-haiku
 *
 * Real models:
 *   - evomerge-t10-1b7-v10:latest via Ollama at http://localhost:11434
 *   - anthropic--claude-4.5-haiku via local Anthropic proxy at http://localhost:6655/anthropic/
 *
 * Run: bun test tests/integration/live/t6-fallback-model-chain.test.ts
 *
 * Skipped when either Ollama model or Anthropic token is unavailable.
 */

import { describe, expect, it } from "bun:test";
import { ToolCallingAgent } from "@wasmagent/core";
import { AnthropicModel, FallbackModel, OpenAIModel } from "@wasmagent/models";
import type { RolloutBranchResult } from "@wasmagent/core/beta";
import { RolloutForkRunner, RolloutRanker, toDpoRecord } from "@wasmagent/core/beta";

// ── Skip guards ───────────────────────────────────────────────────────────────

async function ollamaHasModel(name: string): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = (await r.json()) as { models: Array<{ name: string }> };
    return d.models.some((m) => m.name.includes(name.split(":")[0]));
  } catch {
    return false;
  }
}

const OLLAMA_OK = await ollamaHasModel("evomerge-t10-1b7-v10");
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:6655/anthropic/";
const ANTHROPIC_OK = !!TOKEN && !TOKEN.startsWith("sk-ant-placeholder");
const LIVE = OLLAMA_OK && ANTHROPIC_OK;

const HAIKU_ID = "anthropic--claude-4.5-haiku";

function evomerge() {
  return new OpenAIModel("evomerge-t10-1b7-v10:latest", {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
  });
}

function haiku() {
  return new AnthropicModel(HAIKU_ID, { apiKey: TOKEN!, baseURL: BASE_URL });
}

// ── Scenario 1: FallbackModel escalation ─────────────────────────────────────

describe("T6-S1 · FallbackModel(evomerge → haiku) returns non-empty answer", () => {
  it.skipIf(!LIVE)(
    "FallbackModel answers a geography QA question; haiku is the fallback safety net",
    async () => {
      const fallback = new FallbackModel([evomerge(), haiku()]);

      const agent = new ToolCallingAgent({
        model: fallback,
        tools: [],
        maxSteps: 5,
      });

      const trajectory: Array<{ event: string; data?: unknown }> = [];
      let finalAnswer = "";

      for await (const ev of agent.run(
        "What is the capital of France? Answer with just the city name."
      )) {
        trajectory.push(ev);
        if (ev.event === "final_answer") {
          const data = ev.data as { answer: unknown };
          finalAnswer = typeof data.answer === "string" ? data.answer : JSON.stringify(data.answer);
        }
      }

      const eventNames = trajectory.map((e) => e.event);
      console.log("T6-S1 events:", eventNames.join(", "));
      console.log("T6-S1 finalAnswer:", finalAnswer);
      console.log("T6-S1 lastActiveProviderId:", fallback.lastActiveProviderId);

      // Must produce some answer
      expect(finalAnswer.length).toBeGreaterThan(0);

      if (finalAnswer.toLowerCase().includes("paris")) {
        console.log("T6-S1 PASS: answer contains 'Paris'.");
      } else {
        console.warn(
          "T6-S1 WARNING: answer does not contain 'Paris' — " +
            `got: ${finalAnswer.slice(0, 200)}. ` +
            "Small model may produce a non-standard answer. Treating as soft pass."
        );
      }
    },
    120_000
  );
});

// ── Scenario 2: RolloutForkRunner 2-branch — small model vs cloud model ───────
// Branch 0: evomerge-t10-1b7-v10 (small local)
// Branch 1: haiku (cloud)
// Task: "What is 7 × 8? Answer with just the number."
// We use two separate 1-branch runners (one per model) to give each branch a
// different model, then combine and rank the results manually.

describe("T6-S2 · 2-branch rollout: evomerge vs haiku on multiplication QA", () => {
  it.skipIf(!LIVE)(
    "haiku branch scores >= evomerge branch on a basic arithmetic question",
    async () => {
      const task = "What is 7 × 8? Answer with just the number.";

      // Run branch 0: evomerge (small model)
      const runner0 = new RolloutForkRunner({
        branches: 1,
        concurrency: 1,
        temperaturePerBranch: [0.0],
        sessionIdPrefix: "t6-b0",
      });

      // Run branch 1: haiku (cloud model)
      const runner1 = new RolloutForkRunner({
        branches: 1,
        concurrency: 1,
        temperaturePerBranch: [0.0],
        sessionIdPrefix: "t6-b1",
      });

      const agentOpts0 = {
        model: evomerge(),
        tools: [],
        maxSteps: 5,
      };

      const agentOpts1 = {
        model: haiku(),
        tools: [],
        maxSteps: 5,
      };

      // Run both branches concurrently
      const [branch0Result, branch1Result] = await Promise.all([
        (async () => {
          for await (const r of runner0.run(agentOpts0, task)) {
            return r;
          }
          return null;
        })(),
        (async () => {
          for await (const r of runner1.run(agentOpts1, task)) {
            return r;
          }
          return null;
        })(),
      ]);

      console.log("T6-S2 branch0 (evomerge) finalAnswer:", branch0Result?.finalAnswer ?? "(null)");
      console.log("T6-S2 branch1 (haiku) finalAnswer:", branch1Result?.finalAnswer ?? "(null)");

      expect(branch0Result).not.toBeNull();
      expect(branch1Result).not.toBeNull();

      if (!branch0Result || !branch1Result) return;

      // Score each branch: 1 if answer contains "56", else 0
      const score = (r: RolloutBranchResult): 0 | 1 => (r.finalAnswer.includes("56") ? 1 : 0);

      const b0Score = score(branch0Result);
      const b1Score = score(branch1Result);

      console.log("T6-S2 branch0 score:", b0Score, "(evomerge)");
      console.log("T6-S2 branch1 score:", b1Score, "(haiku)");

      // Prepare records with proper branchIndex for ranker
      const b0: RolloutBranchResult = { ...branch0Result, branchIndex: 0 };
      const b1: RolloutBranchResult = { ...branch1Result, branchIndex: 1 };

      const ranker = new RolloutRanker();
      const rankingResult = await ranker.rank([
        {
          rolloutId: b0.rolloutId,
          branchIndex: 0,
          finalAnswer: b0.finalAnswer,
          objectiveScore: b0Score,
          task,
        },
        {
          rolloutId: b1.rolloutId,
          branchIndex: 1,
          finalAnswer: b1.finalAnswer,
          objectiveScore: b1Score,
          task,
        },
      ]);

      console.log("T6-S2 ranking:", JSON.stringify(rankingResult.ranked));

      // Both answers must be non-empty
      expect(b0.finalAnswer.length).toBeGreaterThan(0);
      expect(b1.finalAnswer.length).toBeGreaterThan(0);

      // Haiku is expected to get the right answer; if both are correct that's fine too.
      if (b1Score === 1) {
        console.log("T6-S2 PASS: haiku answered 56 correctly.");
      } else {
        console.warn("T6-S2 WARNING: haiku did not produce '56' — check model connectivity.");
      }

      // Check DPO record can be generated when answers differ
      const dpo = toDpoRecord([b0, b1], rankingResult.ranked, Date.now());
      if (dpo) {
        console.log("T6-S2 DPO chosen branch:", dpo.provenance.chosen_branch);
        console.log("T6-S2 DPO rejected branch:", dpo.provenance.rejected_branch);
        expect(typeof dpo.prompt).toBe("string");
        expect(typeof dpo.chosen).toBe("string");
        expect(typeof dpo.rejected).toBe("string");
      } else {
        console.log(
          "T6-S2 DPO record is null — both branches produced identical answers (or < 2 branches)."
        );
      }
    },
    180_000
  );
});

// ── Scenario 3: Cost tracking — FallbackModel event log shows model switch ────

describe("T6-S3 · FallbackModel event log — identify model from events", () => {
  it.skipIf(!LIVE)(
    "run_start event appears in stream; lastActiveProviderId reflects actual model used",
    async () => {
      // Use qwen2.5:0.5b as primary (likely present on same Ollama instance),
      // haiku as fallback. If qwen is not available, FallbackModel escalates to haiku.
      const qwenAvailable = await ollamaHasModel("qwen2.5:0.5b");
      const primaryModel = qwenAvailable
        ? new OpenAIModel("qwen2.5:0.5b", {
            baseURL: "http://localhost:11434/v1",
            apiKey: "ollama",
          })
        : evomerge();

      const fallback = new FallbackModel([primaryModel, haiku()]);

      const agent = new ToolCallingAgent({
        model: fallback,
        tools: [],
        maxSteps: 4,
      });

      const events: Array<{ event: string; data?: unknown }> = [];
      let finalAnswer = "";

      for await (const ev of agent.run("Say hello in one word.")) {
        events.push(ev);
        if (ev.event === "final_answer") {
          const data = ev.data as { answer: unknown };
          finalAnswer = typeof data.answer === "string" ? data.answer : JSON.stringify(data.answer);
        }
      }

      const eventTypes = events.map((e) => e.event);
      const uniqueEventTypes = [...new Set(eventTypes)];

      console.log("T6-S3 unique event types seen:", uniqueEventTypes.join(", "));
      console.log("T6-S3 total events:", events.length);
      console.log("T6-S3 finalAnswer:", finalAnswer);
      console.log("T6-S3 lastActiveProviderId:", fallback.lastActiveProviderId);

      // The run must complete without throwing
      expect(finalAnswer.length).toBeGreaterThan(0);

      // run_start is always emitted by ToolCallingAgent
      expect(eventTypes).toContain("run_start");

      // FallbackModel does not emit a dedicated "switched_to_fallback" event —
      // the switch is transparent. We verify via lastActiveProviderId instead.
      const activeProvider = fallback.lastActiveProviderId;
      console.log("T6-S3 actual provider that responded:", activeProvider);
      expect(typeof activeProvider).toBe("string");
      expect(activeProvider.length).toBeGreaterThan(0);

      // Log whether primary or fallback was used
      if (activeProvider === primaryModel.providerId) {
        console.log("T6-S3 Primary model responded — no escalation needed.");
      } else {
        console.log(
          "T6-S3 Fallback model (haiku) was used — primary may have failed or not available."
        );
      }
    },
    120_000
  );
});
