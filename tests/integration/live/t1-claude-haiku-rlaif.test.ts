/**
 * T1 · Claude Haiku — tool-calling agent + RLAIF 3-branch rollout
 *
 * Real model: anthropic--claude-4.5-haiku via local proxy.
 * Run: bun test tests/integration/live/t1-claude-haiku-rlaif.test.ts
 *
 * Skipped when ANTHROPIC_AUTH_TOKEN is unset or is a placeholder.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { AnthropicModel, InMemoryVectorStore, ScalarLLMJudgeVerifier } from "@wasmagent/core";
import {
  DEFAULT_REWARD_FUNCTIONS,
  RolloutForkRunner,
  RolloutMemoryStore,
  RolloutRanker,
  toDpoRecord,
  toPpoRecords,
  toJsonl,
} from "@wasmagent/core/beta";
import type { RolloutBranchResult } from "@wasmagent/core/beta";

// ── Skip guard ────────────────────────────────────────────────────────────────

const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:6655/anthropic/";
const LIVE = !!TOKEN && !TOKEN.startsWith("sk-ant-placeholder");

const HAIKU_ID = "anthropic--claude-4.5-haiku";

function haiku() {
  return new AnthropicModel(HAIKU_ID, { apiKey: TOKEN!, baseURL: BASE_URL });
}

// ── Shared tools ──────────────────────────────────────────────────────────────

const addTool = {
  name: "add",
  description: "Add two integers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }: { a: number; b: number }) => String(a + b),
};

const multiplyTool = {
  name: "multiply",
  description: "Multiply two integers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }: { a: number; b: number }) => String(a * b),
};

// ── Scenario 1: 3-branch RLAIF rollout → DPO + PPO ───────────────────────────

describe("T1-S1 · 3-branch RLAIF rollout with real Haiku", () => {
  it.skipIf(!LIVE)("produces ranked DPO + PPO records with correct provenance", async () => {
    const runner = new RolloutForkRunner({
      branches: 3,
      concurrency: 3,
      temperaturePerBranch: [0.0, 0.4, 0.8],
    });

    const branches: RolloutBranchResult[] = [];
    for await (const r of runner.run(
      { model: haiku(), tools: [addTool, multiplyTool], maxSteps: 5 },
      "Use add(7, 8) then multiply the result by 3. Give the final numeric answer.",
      "t1-s1-rollout"
    )) {
      branches.push(r);
      console.log(`  branch ${r.branchIndex}: "${r.finalAnswer.slice(0, 60)}"`);
    }

    expect(branches.length).toBe(3);
    expect(new Set(branches.map((b) => b.rolloutId)).size).toBe(1);

    for (const b of branches) {
      const events = b.trajectory.map((e) => e.event);
      expect(events).toContain("run_start");
      expect(events).toContain("final_answer");
    }

    // Objective: answer contains "45" (7+8=15, 15×3=45)
    const withScores = branches.map((b) => ({
      ...b,
      objectiveScore: (b.finalAnswer.includes("45") ? 1 : 0) as 0 | 1,
    }));

    const ranker = new RolloutRanker({ rewardFunctions: DEFAULT_REWARD_FUNCTIONS });
    const ranked = await ranker.rank(withScores.map((b) => ({
      rolloutId: b.rolloutId,
      task: b.task,
      branchIndex: b.branchIndex,
      finalAnswer: b.finalAnswer,
      objectiveScore: b.objectiveScore,
    })));

    expect(ranked.ranked.length).toBe(3);
    console.log("T1-S1 ranked:", ranked.ranked.map(
      (r) => `branch${r.branchIndex}=score${r.totalScore.toFixed(2)}`
    ).join(", "));

    const exportedAtMs = Date.now();
    const dpo = toDpoRecord(withScores, ranked.ranked, exportedAtMs);
    const ppo = toPpoRecords(withScores, ranked.ranked, exportedAtMs);

    expect(ppo.length).toBe(3);
    for (const r of ppo) {
      expect(r.provenance.source).toBe("wasmagent-rollout");
      expect(typeof r.provenance.branch_index).toBe("number");
      expect(r.provenance.exported_at_ms).toBe(exportedAtMs);
      expect(r.provenance.rollout_id.length).toBeGreaterThan(0);
    }

    if (dpo) {
      expect(dpo.provenance.source).toBe("wasmagent-rollout");
      expect(dpo.provenance.chosen_branch).not.toBe(dpo.provenance.rejected_branch);
      // Verify JSONL round-trip
      const jsonl = toJsonl(ppo);
      const lines = jsonl.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const rec = JSON.parse(line) as { provenance: { source: string } };
        expect(rec.provenance.source).toBe("wasmagent-rollout");
      }
      console.log("T1-S1 PASS — DPO chosen branch:", dpo.provenance.chosen_branch,
        "→", dpo.chosen.slice(0, 60));
    } else {
      console.log("T1-S1 NOTE: no DPO pair (all branches equal score)");
    }
  }, 120_000);
});

// ── Scenario 2: ScalarLLMJudgeVerifier pairwise discrimination ────────────────

describe("T1-S2 · ScalarLLMJudgeVerifier pairwise discrimination with real Haiku", () => {
  it.skipIf(!LIVE)("prefers clearly correct answer over refusal", async () => {
    const judge = new ScalarLLMJudgeVerifier({
      model: haiku(),
      samples: 1,
      temperature: 0.0,
    });

    const good = "The sum of 17 and 25 is 42. I used the add tool which returned 42.";
    const bad  = "I cannot answer mathematical questions without more context.";

    const result = await judge.comparePair({
      criterionDescription: "Which answer better addresses the task of computing 17 + 25?",
      outputA: good,
      outputB: bad,
    });

    console.log("T1-S2 judge:", result.preferred, "—", result.reasoning?.slice(0, 80));
    expect(result.preferred).toBe("a");
    expect(result.reasoning.length).toBeGreaterThan(0);
  }, 30_000);
});

// ── Scenario 3: RolloutMemoryStore cross-batch seeding ────────────────────────

describe("T1-S3 · RolloutMemoryStore cross-batch seeding with real Haiku", () => {
  it.skipIf(!LIVE)("batch-2 receives injected context from batch-1 winner", async () => {
    const store = new InMemoryVectorStore();
    const memStore = new RolloutMemoryStore({ store });

    // Batch 1: 1 branch — simple addition
    const runner1 = new RolloutForkRunner({ branches: 1, temperaturePerBranch: [0.0] });
    const branches1: RolloutBranchResult[] = [];
    for await (const r of runner1.run(
      { model: haiku(), tools: [addTool], maxSteps: 4 },
      "Use add(12, 5) and tell me the result.",
      "t1-s3-batch1"
    )) branches1.push(r);

    expect(branches1.length).toBe(1);
    expect(branches1[0].finalAnswer.length).toBeGreaterThan(0);

    // Persist winner to memory store (upsert only stores objectiveScore=1)
    await memStore.upsert({
      rolloutId: branches1[0].rolloutId,
      task: branches1[0].task,
      finalAnswer: branches1[0].finalAnswer,
      keySteps: branches1[0].toolCallSequence
        .filter((e) => e.event === "tool_result")
        .map((e) => String((e.data as { output?: unknown })?.output ?? ""))
        .join("; "),
      objectiveScore: 1,
      branchIndex: 0,
    });

    // Retrieve memories
    const memories = await memStore.retrieve("math addition problem", 3);
    expect(memories.length).toBeGreaterThan(0);
    const injectedPrompt = RolloutMemoryStore.formatAsSystemPrompt(memories);
    expect(injectedPrompt.length).toBeGreaterThan(0);
    console.log("T1-S3 memory injected (first 100):", injectedPrompt.slice(0, 100));

    // Batch 2: uses injected context
    const runner2 = new RolloutForkRunner({ branches: 1, temperaturePerBranch: [0.0] });
    const branches2: RolloutBranchResult[] = [];
    for await (const r of runner2.run(
      {
        model: haiku(),
        tools: [addTool],
        maxSteps: 4,
        systemPrompt: `${injectedPrompt}\n\nYou are a calculator assistant.`,
      },
      "Use add(20, 3) and tell me the result.",
      "t1-s3-batch2"
    )) branches2.push(r);

    expect(branches2.length).toBe(1);
    expect(branches2[0].finalAnswer.length).toBeGreaterThan(0);
    expect(branches2[0].rolloutId).not.toBe(branches1[0].rolloutId);
    console.log("T1-S3 PASS — batch2 answer:", branches2[0].finalAnswer.slice(0, 80));
  }, 90_000);
});
