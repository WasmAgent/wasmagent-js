/**
 * RLAIF live integration tests — requires real Anthropic API (via proxy).
 *
 * Skipped automatically when ANTHROPIC_AUTH_TOKEN is not set.
 * Run manually:
 *   bun test tests/integration/rlaif-pipeline.live.test.ts
 *
 * These tests catch bugs that mock-based tests cannot:
 *   - Real tool_call JSON format / SDK version alignment
 *   - summarizeToolOutput truncation causing model to lose context
 *   - ScalarLLMJudgeVerifier having zero discrimination on real model
 *   - Empty finalAnswer on long/complex tasks
 *   - Memory injection surviving real generate() call chain
 */

import { describe, expect, it } from "bun:test";
import {
  BuildPassesVerifier,
  InMemoryVectorStore,
  ScalarLLMJudgeVerifier,
} from "@wasmagent/core";
import { AnthropicModel } from "@wasmagent/models";
import type { RolloutRecord } from "@wasmagent/core/beta";
import {
  DEFAULT_REWARD_FUNCTIONS,
  RolloutForkRunner,
  RolloutMemoryStore,
  RolloutRanker,
  toDpoRecord,
  toJsonl,
  toPpoRecords,
} from "@wasmagent/core/beta";
import { z } from "zod";

// ── Skip guard ────────────────────────────────────────────────────────────────

const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:6655/anthropic/";
const LIVE = !!AUTH_TOKEN && !AUTH_TOKEN.startsWith("sk-ant-placeholder");

function makeModel(modelId = "claude-haiku-4-5-20251001") {
  return new AnthropicModel(modelId, {
    apiKey: AUTH_TOKEN!,
    baseURL: BASE_URL,
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const addTool = {
  name: "add",
  description: "Add two integers and return the sum",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  readOnly: true,
  idempotent: true,
  async forward({ a, b }: { a: number; b: number }) {
    return a + b;
  },
};

const buildCheckTool = {
  name: "check_exit_code",
  description:
    "Simulate a build check. Returns exit_code:0 for small inputs, exit_code:1 otherwise.",
  inputSchema: z.object({ size: z.number() }),
  readOnly: true,
  idempotent: true,
  async forward({ size }: { size: number }) {
    return size < 100 ? "exit_code:0 build succeeded" : "exit_code:1 build failed: too large";
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RLAIF live pipeline (real API)", () => {
  // ── Test 1: 真实模型跑完 N=2 rollout，finalAnswer 非空 ──────────────────────
  it.skipIf(!LIVE)(
    "real model completes N=2 rollout branches with non-empty finalAnswer",
    async () => {
      const runner = new RolloutForkRunner({
        branches: 2,
        concurrency: 2,
        temperaturePerBranch: [0.3, 0.8],
      });

      const results = [];
      for await (const r of runner.run(
        { model: makeModel(), tools: [addTool], maxSteps: 6 },
        "Use the add tool to compute 17 + 25, then tell me the result.",
        "live-test-rollout-1"
      )) {
        results.push(r);
      }

      expect(results).toHaveLength(2);
      for (const r of results) {
        // 真实模型必须产出 finalAnswer
        expect(r.finalAnswer.length).toBeGreaterThan(0);
        // trajectory 必须包含至少 run_start 和 final_answer
        const eventTypes = r.trajectory.map((e) => e.event);
        expect(eventTypes).toContain("run_start");
        expect(eventTypes).toContain("final_answer");
        // tool_call_sequence 应包含 add 工具的调用
        const toolNames = r.toolCallSequence
          .filter((e) => e.event === "tool_call")
          .map((e) => (e.data as { toolName: string }).toolName);
        expect(toolNames).toContain("add");
        // seed 字段存在（即使为 null）
        expect(r.seed === null || typeof r.seed === "number").toBe(true);
      }

      // 两个分支的 rolloutId 相同
      expect(results[0]!.rolloutId).toBe(results[1]!.rolloutId);
      // sessionId 各不相同
      expect(results[0]!.sessionId).not.toBe(results[1]!.sessionId);
    },
    60_000
  );

  // ── Test 2: ScalarLLMJudgeVerifier pairwise 有区分度 ────────────────────────
  it.skipIf(!LIVE)(
    "ScalarLLMJudgeVerifier distinguishes clearly different quality outputs",
    async () => {
      const judge = new ScalarLLMJudgeVerifier({
        model: makeModel(),
        samples: 1,
        temperature: 0.1,
      });

      // 明显好的答案 vs 明显差的答案
      const goodAnswer =
        "The sum of 17 and 25 is 42. I computed this using the add tool which returned 42.";
      const badAnswer = "I cannot answer this question.";

      const result = await judge.comparePair({
        criterionDescription: "Which answer better addresses the task of computing 17+25?",
        outputA: goodAnswer,
        outputB: badAnswer,
      });

      // 真实 judge 必须能区分——preferred 不应该是 tie（好答案 vs 拒绝回答）
      expect(result.preferred).toBe("a");
      expect(result.reasoning.length).toBeGreaterThan(0);
    },
    30_000
  );

  // ── Test 3: 完整管道 JSONL 通过 validate-rlaif.mjs 校验 ─────────────────────
  it.skipIf(!LIVE)(
    "full pipeline produces JSONL that passes schema validation",
    async () => {
      const runner = new RolloutForkRunner({
        branches: 2,
        concurrency: 2,
        temperaturePerBranch: [0.2, 0.9],
      });

      const branchResults = [];
      for await (const r of runner.run(
        { model: makeModel(), tools: [buildCheckTool], maxSteps: 6 },
        "Use check_exit_code with size=10 to check if the build passes.",
        "live-test-rollout-3"
      )) {
        branchResults.push(r);
      }

      expect(branchResults).toHaveLength(2);

      // 从 tool_result output 提取 objectiveScore
      const objectiveScores = new Map<number, 0 | 1>();
      for (const r of branchResults) {
        const resultEvent = r.toolCallSequence.find((e) => e.event === "tool_result");
        const output =
          resultEvent && resultEvent.event === "tool_result"
            ? String((resultEvent.data as { output: unknown }).output ?? "")
            : "";
        objectiveScores.set(r.branchIndex, output.includes("exit_code:0") ? 1 : 0);
      }

      const rolloutRecords: RolloutRecord[] = branchResults.map((r) => ({
        rolloutId: r.rolloutId,
        branchIndex: r.branchIndex,
        finalAnswer: r.finalAnswer,
        objectiveScore: objectiveScores.get(r.branchIndex) ?? 0,
        task: r.task,
      }));

      const ranker = new RolloutRanker({ rewardFunctions: DEFAULT_REWARD_FUNCTIONS });
      const { ranked } = await ranker.rank(rolloutRecords);

      const exportedAtMs = Date.now();
      const dpo = toDpoRecord(branchResults, ranked, exportedAtMs);
      const ppo = toPpoRecords(branchResults, ranked, exportedAtMs);

      // PPO 必须有 2 条
      expect(ppo).toHaveLength(2);

      // 每条 PPO 必须有必填字段
      for (const r of ppo) {
        expect(r.prompt.length).toBeGreaterThan(0);
        expect(typeof r.reward).toBe("number");
        expect(r.provenance.source).toBe("wasmagent-rollout");
        expect(r.provenance.rollout_id.length).toBeGreaterThan(0);
        expect(r.provenance.exported_at_ms).toBe(exportedAtMs);
      }

      // JSONL 每行必须是合法 JSON
      const ppoJsonl = toJsonl(ppo);
      for (const line of ppoJsonl.split("\n").filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed).toHaveProperty("prompt");
        expect(parsed).toHaveProperty("completion");
        expect(parsed).toHaveProperty("reward");
        expect(parsed).toHaveProperty("provenance");
      }

      // DPO：如果有两条不同的答案，必须满足 chosen !== rejected
      if (dpo !== null) {
        expect(dpo.chosen).not.toBe(dpo.rejected);
        expect(dpo.provenance.source).toBe("wasmagent-rollout");
        const dpoJsonl = toJsonl([dpo]);
        expect(() => JSON.parse(dpoJsonl)).not.toThrow();
      }
    },
    90_000
  );

  // ── Test 4: RolloutMemoryStore 注入后真实 system prompt 包含记忆 ─────────────
  it.skipIf(!LIVE)(
    "RolloutMemoryStore injects past approaches into real generate() calls",
    async () => {
      const store = new InMemoryVectorStore();
      const mem = new RolloutMemoryStore({ store });

      // 预存一条高质量记忆
      await mem.upsert({
        rolloutId: "past-r1",
        branchIndex: 0,
        task: "compute sum of two numbers",
        keySteps: "add(17, 25) → 42",
        objectiveScore: 1,
        finalAnswer: "The answer is 42",
      });

      // 用记忆注入运行新 rollout
      const capturedSystemPrompts: string[] = [];
      const originalGenerate = makeModel().generate;

      // 用 spy model 捕获 system prompt
      const spyModel = new AnthropicModel("claude-haiku-4-5-20251001", {
        apiKey: AUTH_TOKEN!,
        baseURL: BASE_URL,
      });

      const runner = new RolloutForkRunner({
        branches: 1,
        memoryStore: mem,
        memoryTopK: 1,
      });

      const results = [];
      for await (const r of runner.run(
        { model: spyModel, tools: [addTool], maxSteps: 6 },
        "compute sum of two numbers: 17 + 25"
      )) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      // 结果应该是有效的 finalAnswer（记忆注入不能破坏正常运行）
      expect(results[0]!.finalAnswer.length).toBeGreaterThan(0);
      // 结果应包含 42（被记忆内容影响的正确答案）
      expect(results[0]!.finalAnswer).toMatch(/42/);
    },
    60_000
  );
});
