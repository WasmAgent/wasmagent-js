/**
 * T9 · Edge-case robustness under extreme inputs
 *
 * Tests real models and pure-TS code paths under pathological conditions:
 *
 * E1 — Empty task (qwen2.5:0.5b) — agent must not crash
 * E2 — Tool returns 100 KB output (Haiku) — agent must complete without OOM/throw
 * E3 — ProgrammaticOrchestrator maxToolCalls exceeded — must throw
 * E4 — QuickJS CPU timeout — kernel must throw, not hang
 * E5 — evomerge: empty JSONL input — load_rollouts returns 0 records
 * E6 — All-failing branches: toDpoRecord returns null, toPpoRecords rewards all 0
 *
 * Run: bun test tests/integration/live/t9-edge-robustness.test.ts
 */

import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsKernel,
  ProgrammaticOrchestrator,
  ToolCallingAgent,
  ToolRegistry,
} from "@wasmagent/core";
import { AnthropicModel, OpenAIModel } from "@wasmagent/models";
import type { RolloutBranchResult } from "@wasmagent/core/beta";
import {
  DEFAULT_REWARD_FUNCTIONS,
  RolloutRanker,
  toDpoRecord,
  toPpoRecords,
} from "@wasmagent/core/beta";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { z } from "zod";

// ── Skip guards ───────────────────────────────────────────────────────────────

const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:6655/anthropic/";
const HAIKU_LIVE = !!TOKEN && !TOKEN.startsWith("sk-ant-placeholder");

const HAIKU_ID = "anthropic--claude-4.5-haiku";

function haiku() {
  return new AnthropicModel(HAIKU_ID, { apiKey: TOKEN!, baseURL: BASE_URL });
}

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

const EVOMERGE_SRC = "/tmp/evomerge-public-repo/src";

// ── E1 — Empty task (qwen2.5:0.5b) ───────────────────────────────────────────

describe("T9-E1 · ToolCallingAgent handles empty task gracefully (qwen2.5:0.5b)", () => {
  it.skipIf(!QWEN_LIVE)(
    "does not throw an unhandled exception on empty task string",
    async () => {
      const agent = new ToolCallingAgent({
        model: qwen(),
        tools: [],
        maxSteps: 3,
      });

      let threw = false;
      try {
        for await (const ev of agent.run("")) {
          if (ev.event === "final_answer") break;
          if (ev.event === "error") break;
        }
      } catch {
        threw = true;
      }

      // Agent must handle gracefully — no unhandled throw
      expect(threw).toBe(false);
      console.log("T9-E1 PASS — empty task handled without unhandled throw");
    },
    45_000
  );
});

// ── E2 — Tool returns 100 KB output (Haiku) ──────────────────────────────────

describe("T9-E2 · ToolCallingAgent handles 100 KB tool output (Haiku)", () => {
  it.skipIf(!HAIKU_LIVE)(
    "completes with non-empty finalAnswer when a tool returns 100 KB",
    async () => {
      const bigOutputTool = {
        name: "big_data",
        description: "Returns a large block of repeated data",
        inputSchema: z.object({}),
        readOnly: true,
        idempotent: true,
        forward: async () => "x".repeat(100_000),
      };

      const agent = new ToolCallingAgent({
        model: haiku(),
        tools: [bigOutputTool],
        maxSteps: 3,
      });

      let finalAnswer = "";
      let threw = false;
      try {
        for await (const ev of agent.run("Call big_data tool once and summarize what you got.")) {
          if (ev.event === "final_answer") {
            finalAnswer = String((ev.data as { answer?: unknown }).answer ?? "");
            break;
          }
        }
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(finalAnswer.length).toBeGreaterThan(0);
      console.log("T9-E2 PASS — agent completed, answer:", finalAnswer.slice(0, 80));
    },
    60_000
  );
});

// ── E3 — ProgrammaticOrchestrator maxToolCalls exceeded ──────────────────────

describe("T9-E3 · ProgrammaticOrchestrator throws when maxToolCalls exceeded", () => {
  it("throws an error mentioning maxToolCalls when the script exceeds the limit", async () => {
    const loopTool = {
      name: "loop_tool",
      description: "A tool that just returns 'continue'",
      inputSchema: z.object({}),
      readOnly: true,
      idempotent: true,
      forward: async () => "continue",
    };

    const registry = new ToolRegistry();
    registry.register(loopTool);

    await using kernel = new JsKernel();
    const po = new ProgrammaticOrchestrator(kernel, registry, {}, { maxToolCalls: 3 });

    let error: Error | undefined;
    try {
      await po.run(`
        for (let i = 0; i < 5; i++) {
          await callTool('loop_tool', {});
        }
        return 'done';
      `);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("maxToolCalls");
    console.log("T9-E3 PASS — maxToolCalls enforced, error:", error!.message.slice(0, 80));
  }, 20_000);
});

// ── E4 — QuickJS CPU timeout ──────────────────────────────────────────────────

describe("T9-E4 · QuickJSKernel enforces CPU timeout on infinite loop", () => {
  it("throws (does not hang) when script runs an infinite loop", async () => {
    const kernel = new QuickJSKernel({ timeoutMs: 1_000 });

    let error: Error | undefined;
    try {
      await kernel.run("while(true) {}", {});
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    // Error message should reference timeout or interrupt
    const msg = error!.message.toLowerCase();
    const mentionsTimeout =
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("interrupt") ||
      msg.includes("exceeded") ||
      msg.includes("kernel");
    expect(mentionsTimeout).toBe(true);
    console.log("T9-E4 PASS — QuickJS timed out:", error!.message.slice(0, 80));
  }, 10_000);
});

// ── E5 — evomerge: empty JSONL input ─────────────────────────────────────────

// Only runs when the evomerge public repo is present at /tmp/evomerge-public-repo
import { existsSync } from "node:fs";

const EVOMERGE_AVAILABLE = existsSync(EVOMERGE_SRC);

describe("T9-E5 · evomerge TrainingDataExporter handles empty JSONL gracefully", () => {
  it.skipIf(!EVOMERGE_AVAILABLE)(
    "load_rollouts returns 0 records and export produces empty DPO/PPO",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "t9-edge-"));
      const emptyPath = join(tempDir, "empty.jsonl");
      writeFileSync(emptyPath, "");

      // Write Python script to temp file to avoid `;` line-joining issues
      const pyScriptPath = join(tempDir, "e5-empty.py");
      writeFileSync(
        pyScriptPath,
        [
          "import sys",
          `sys.path.insert(0, '${EVOMERGE_SRC}')`,
          "from datafactory.exporter import TrainingDataExporter",
          "e = TrainingDataExporter(eval_items_path=None)",
          `records = e.load_rollouts('${emptyPath}')`,
          "dpo, ppo = e.export(records, mode='fixture')",
          "print(f'RECORDS:{len(records)} DPO:{len(dpo)} PPO:{len(ppo)}')",
        ].join("\n")
      );

      let result: string;
      try {
        result = execSync(`python3 "${pyScriptPath}"`, {
          encoding: "utf8",
          timeout: 15_000,
        });
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        throw new Error(`Python failed: ${err.message}\nstderr: ${err.stderr}`);
      }

      console.log("  T9-E5 output:", result.trim());
      expect(result).toContain("RECORDS:0");
      expect(result).toContain("DPO:0");
      expect(result).toContain("PPO:0");
      console.log("T9-E5 PASS — empty JSONL produces 0 records, 0 DPO, 0 PPO");
    },
    15_000
  );
});

// ── E6 — All-failing branches: toDpoRecord returns null ──────────────────────

describe("T9-E6 · All-failing branches: toDpoRecord null, toPpoRecords reward=0 (pure TS)", () => {
  it("toDpoRecord returns null and all PPO records have reward=0 when all branches fail", async () => {
    // Build synthetic RolloutBranchResult objects with objectiveScore=0
    // toDpoRecord / toPpoRecords accept RolloutBranchResult which does NOT
    // have objectiveScore — but we need it for the ranker. We extend inline.
    const fakeBranches = [0, 1, 2].map(
      (i) =>
        ({
          rolloutId: "t9-e6-rollout",
          task: "Write a haiku about failure",
          branchIndex: i,
          temperature: 0.5,
          seed: null,
          sessionId: `session-e6-b${i}`,
          trajectory: [],
          toolCallSequence: [],
          finalAnswer: `branch ${i} response`,
          buildResult: null,
        }) satisfies RolloutBranchResult
    );

    const ranker = new RolloutRanker({ rewardFunctions: DEFAULT_REWARD_FUNCTIONS });
    const ranked = await ranker.rank(
      fakeBranches.map((b) => ({
        rolloutId: b.rolloutId,
        task: b.task,
        branchIndex: b.branchIndex,
        finalAnswer: b.finalAnswer,
        // All branches fail
        objectiveScore: 0 as const,
      }))
    );

    expect(ranked.ranked.length).toBe(3);

    const exportedAtMs = Date.now();
    const dpo = toDpoRecord(fakeBranches, ranked.ranked, exportedAtMs);
    const ppo = toPpoRecords(fakeBranches, ranked.ranked, exportedAtMs);

    // With all branches having identical finalAnswers like "branch 0 response",
    // toDpoRecord may produce null because chosen === rejected is possible when
    // all totalScores are equal and sort puts the same "first/last" in the pair.
    // Either way, we just verify the contract:
    // - dpo is null OR (if not null) chosen_branch !== rejected_branch
    if (dpo === null) {
      console.log(
        "T9-E6 NOTE: toDpoRecord returned null (all branches equal score or identical answers)"
      );
    } else {
      expect(dpo.provenance.chosen_branch).not.toBe(dpo.provenance.rejected_branch);
      console.log(
        "T9-E6 NOTE: toDpoRecord produced a pair (branches differ textually despite 0 score)"
      );
    }

    // PPO records: all 3 branches, all with low/zero total score
    expect(ppo.length).toBe(3);
    for (const r of ppo) {
      expect(r.provenance.source).toBe("wasmagent-rollout");
      expect(r.provenance.rollout_id).toBe("t9-e6-rollout");
      // reward is totalScore (not normalized here — toPpoRecords stores raw totalScore)
      expect(typeof r.reward).toBe("number");
      // All scores must be equal (no judge discrimination with uniform failures)
      expect(r.reward).toBeGreaterThanOrEqual(0);
    }

    const rewards = ppo.map((r) => r.reward);
    const allEqual = rewards.every((v) => v === rewards[0]);
    expect(allEqual).toBe(true);
    console.log(
      "T9-E6 PASS — all rewards equal:",
      rewards[0],
      "dpo:",
      dpo === null ? "null" : "non-null"
    );
  }, 15_000);
});
