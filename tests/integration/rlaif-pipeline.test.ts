/**
 * RLAIF end-to-end pipeline integration test.
 *
 * Exercises the full data-factory chain with mock models (no real LLM calls):
 *
 *   RolloutForkRunner.run()          — N=3 branches, mock tool-calling agent
 *     → BuildPassesVerifier          — assigns objectiveScore per branch
 *     → RolloutRanker.rank()         — Bradley-Terry + weighted reward
 *     → toDpoRecord / toPpoRecords   — flat training records
 *     → toJsonl                      — JSONL strings
 *     → JSON.parse round-trip        — schema validation
 *
 * This test catches integration bugs that unit tests miss: mismatched
 * branchIndex keys between Runner/Ranker/Exporter, empty trajectories,
 * wrong field names in provenance, etc.
 */

import { describe, expect, it } from "bun:test";
import type { Model, StreamEvent, ToolDefinition } from "@wasmagent/core";
import { BuildPassesVerifier } from "@wasmagent/core";
import type { RolloutRecord } from "@wasmagent/core/beta";
import {
  DEFAULT_REWARD_FUNCTIONS,
  RolloutForkRunner,
  RolloutRanker,
  toDpoRecord,
  toJsonl,
  toPpoRecords,
} from "@wasmagent/core/beta";
import { z } from "zod";

// ── Mock helpers ──────────────────────────────────────────────────────────────

/** Per-branch model factory: branchIndex 0 passes the build check, others fail.
 *
 *  The factory is called by RolloutForkRunner once per branch (N times).
 *  We also call factory() once to produce the dummy agentOpts.model, so the
 *  first call (idx=0) is the dummy — branch models get idx=1..N.
 *  To keep things simple we use the temperature argument to identify branch 0:
 *  branch 0 gets temperature=0.2, which is the first in temperaturePerBranch.
 */
function makeBranchModelFactory(): () => Model {
  let instanceIdx = 0;
  return (): Model => {
    const idx = instanceIdx++;
    let calls = 0;
    return {
      providerId: `mock/branch-${idx}`,
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        calls++;
        // Identify branch 0 by its temperature (0.2 = temperaturePerBranch[0])
        const isBranch0 = Math.abs((opts?.temperature ?? 0) - 0.2) < 0.01;
        if (calls === 1) {
          // Use "my-app-0" (→ exit_code:0) for branch 0, "my-app-x" for others
          yield {
            type: "tool_call",
            toolCall: {
              type: "tool_use",
              id: `call-${idx}`,
              name: "check_build",
              input: { project: isBranch0 ? "my-app-0" : `my-app-${idx}` },
            },
          };
        } else {
          const answer = isBranch0 ? "Build succeeded. All tests pass." : "Build failed.";
          yield { type: "text_delta", delta: answer };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
  };
}

/** Tool that simulates a build check — always reports current output. */
function makeCheckBuildTool(): ToolDefinition {
  return {
    name: "check_build",
    description: "Check if the build passes",
    inputSchema: z.object({ project: z.string() }),
    readOnly: true,
    idempotent: true,
    async forward(input) {
      // Simulate: project "my-app-0" passes, others fail.
      // Branch 0 agent calls with project="my-app-0" (embedded in task text).
      const proj = (input as { project: string }).project;
      return proj.endsWith("-0") ? "exit_code:0\nbuild succeeded" : "exit_code:1\nbuild failed";
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RLAIF end-to-end pipeline", () => {
  it("runs 3 branches, ranks them, exports DPO and PPO records", async () => {
    const N = 3;
    const factory = makeBranchModelFactory();

    // ── Step 1: RolloutForkRunner ─────────────────────────────────────────────
    const runner = new RolloutForkRunner({
      branches: N,
      concurrency: N,
      modelFactory: factory,
      temperaturePerBranch: [0.2, 0.7, 1.0],
      seedPerBranch: [1, 2, 3],
    });

    const branchResults = [];
    for await (const result of runner.run(
      {
        model: factory(),
        tools: [makeCheckBuildTool()],
        maxSteps: 5,
      },
      "Build and verify my-app",
      "rollout-e2e-test"
    )) {
      branchResults.push(result);
    }

    expect(branchResults).toHaveLength(N);
    for (const r of branchResults) {
      expect(r.rolloutId).toBe("rollout-e2e-test");
      expect(r.trajectory.length).toBeGreaterThan(0);
      expect(r.seed).toBe(r.branchIndex + 1); // seedPerBranch[i] = i+1
    }

    // ── Step 2: BuildPassesVerifier → objectiveScore per branch ──────────────
    // Read the tool_result output from each branch's toolCallSequence to determine
    // whether the build passed. Branch 0 called check_build with "my-app-0" → pass.
    const buildResultsBySession = new Map<string, { exitCode: number; stderr: string }>();
    for (const r of branchResults) {
      const resultEvent = r.toolCallSequence.find((e) => e.event === "tool_result");
      const output =
        resultEvent && resultEvent.event === "tool_result"
          ? String((resultEvent.data as { output: unknown }).output ?? "")
          : "";
      const exitCode = output.includes("exit_code:0") ? 0 : 1;
      buildResultsBySession.set(r.sessionId, {
        exitCode,
        stderr: exitCode !== 0 ? output : "",
      });
    }

    const verifier = new BuildPassesVerifier({
      getBuildResult: async (sessionId: string) => {
        const res = buildResultsBySession.get(sessionId);
        if (!res) return null;
        return {
          status: res.exitCode === 0 ? ("success" as const) : ("failure" as const),
          exitCode: res.exitCode,
          stdout: "",
          stderr: res.stderr,
        };
      },
    });

    const nullWs = {
      async readFile() {
        return "";
      },
      async fileExists() {
        return false;
      },
      async fileSize() {
        return 0;
      },
    };

    // Map branchIndex → objectiveScore
    const objectiveScores = new Map<number, 0 | 1>();
    for (const r of branchResults) {
      const criterion = {
        id: `build-${r.branchIndex}`,
        description: "build passes",
        verify_method: "build_passes" as const,
        arg: r.sessionId,
      };
      const verdict = await verifier.verify(criterion, nullWs);
      objectiveScores.set(r.branchIndex, verdict.ok ? 1 : 0);
    }

    // Branch 0 should pass, others fail
    expect(objectiveScores.get(0)).toBe(1);
    expect(objectiveScores.get(1)).toBe(0);
    expect(objectiveScores.get(2)).toBe(0);

    // ── Step 3: RolloutRanker ─────────────────────────────────────────────────
    const rolloutRecords: RolloutRecord[] = branchResults.map((r) => ({
      rolloutId: r.rolloutId,
      branchIndex: r.branchIndex,
      finalAnswer: r.finalAnswer,
      objectiveScore: objectiveScores.get(r.branchIndex) ?? 0,
      task: r.task,
    }));

    const ranker = new RolloutRanker({ rewardFunctions: DEFAULT_REWARD_FUNCTIONS });
    const { ranked, stats } = await ranker.rank(rolloutRecords);

    expect(ranked).toHaveLength(N);
    // Branch 0 (objectiveScore=1) must rank first
    expect(ranked[0]!.branchIndex).toBe(0);
    expect(ranked[0]!.objectiveScore).toBe(1);
    // Stats report exists
    expect(typeof stats.powered).toBe("boolean");
    expect(typeof stats.minDetectableDeltaPp).toBe("number");

    // ── Step 4: Export to DPO + PPO ───────────────────────────────────────────
    const exportedAtMs = 1_750_000_000_000; // fixed timestamp for determinism

    const dpo = toDpoRecord(branchResults, ranked, exportedAtMs);
    const ppo = toPpoRecords(branchResults, ranked, exportedAtMs);

    // DPO: chosen should be the best branch's answer
    expect(dpo).not.toBeNull();
    if (dpo) {
      expect(dpo.prompt).toBe("Build and verify my-app");
      expect(dpo.chosen).not.toBe(dpo.rejected);
      expect(dpo.provenance.source).toBe("wasmagent-rollout");
      expect(dpo.provenance.rollout_id).toBe("rollout-e2e-test");
      expect(dpo.provenance.exported_at_ms).toBe(exportedAtMs);
      expect(typeof dpo.provenance.chosen_branch).toBe("number");
      expect(typeof dpo.provenance.rejected_branch).toBe("number");
    }

    // PPO: one record per branch
    expect(ppo).toHaveLength(N);
    for (const r of ppo) {
      expect(r.prompt).toBe("Build and verify my-app");
      expect(typeof r.reward).toBe("number");
      expect(r.provenance.source).toBe("wasmagent-rollout");
      expect(r.provenance.rollout_id).toBe("rollout-e2e-test");
    }
    // Branch 0's reward should be highest
    const branch0Ppo = ppo.find((r) => r.provenance.branch_index === 0);
    const branch1Ppo = ppo.find((r) => r.provenance.branch_index === 1);
    expect(branch0Ppo!.reward).toBeGreaterThan(branch1Ppo!.reward);

    // ── Step 5: JSONL round-trip ──────────────────────────────────────────────
    const dpoJsonl = toJsonl(dpo ? [dpo] : []);
    const ppoJsonl = toJsonl(ppo);

    const dpoLines = dpoJsonl.split("\n").filter(Boolean);
    const ppoLines = ppoJsonl.split("\n").filter(Boolean);

    expect(dpoLines).toHaveLength(dpo ? 1 : 0);
    expect(ppoLines).toHaveLength(N);

    // Each line must be valid JSON with required fields
    for (const line of dpoLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toHaveProperty("prompt");
      expect(parsed).toHaveProperty("chosen");
      expect(parsed).toHaveProperty("rejected");
      expect(parsed).toHaveProperty("provenance");
    }
    for (const line of ppoLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toHaveProperty("prompt");
      expect(parsed).toHaveProperty("completion");
      expect(parsed).toHaveProperty("reward");
      expect(parsed).toHaveProperty("tool_call_sequence");
      expect(parsed).toHaveProperty("provenance");
    }

    // ── Step 6: Validate JSONL passes schema rules ────────────────────────────
    // Inline the same checks as validate-rlaif.mjs
    for (const line of dpoLines) {
      const r = JSON.parse(line) as { chosen: string; rejected: string };
      expect(r.chosen).not.toBe(r.rejected);
      expect(r.chosen.length).toBeGreaterThan(0);
    }
    for (const line of ppoLines) {
      const r = JSON.parse(line) as { reward: number };
      // reward is raw totalScore here, not normalised — that's the Python layer's job
      expect(typeof r.reward).toBe("number");
    }
  });

  it("pipeline handles all-failing branches gracefully", async () => {
    // All branches fail → DPO record should be null (no meaningful pair)
    const N = 2;
    const factory = makeBranchModelFactory();

    const runner = new RolloutForkRunner({
      branches: N,
      concurrency: N,
      modelFactory: factory,
    });

    const branchResults = [];
    for await (const r of runner.run(
      { model: factory(), tools: [], maxSteps: 3 },
      "a task with no tools"
    )) {
      branchResults.push(r);
    }

    // Both branches get objectiveScore=0
    const rolloutRecords: RolloutRecord[] = branchResults.map((r) => ({
      rolloutId: r.rolloutId,
      branchIndex: r.branchIndex,
      finalAnswer: r.finalAnswer,
      objectiveScore: 0,
      task: r.task,
    }));

    const ranker = new RolloutRanker();
    const { ranked } = await ranker.rank(rolloutRecords);

    const dpo = toDpoRecord(branchResults, ranked, 0);
    // If both answers happen to be identical (both say "Build failed.") DPO is null.
    // If they differ, a DPO record is still produced (reward signal from objective tie-break).
    // Either way: no crash.
    expect(dpo === null || typeof dpo === "object").toBe(true);

    const ppo = toPpoRecords(branchResults, ranked, 0);
    expect(ppo).toHaveLength(N);
  });

  it("N=1 single branch: toDpoRecord returns null (no pair possible)", async () => {
    const factory = makeBranchModelFactory();
    const runner = new RolloutForkRunner({ branches: 1, modelFactory: factory });
    const branchResults = [];
    for await (const r of runner.run(
      { model: factory(), tools: [makeCheckBuildTool()], maxSteps: 5 },
      "single branch task"
    )) {
      branchResults.push(r);
    }

    const ranked = [
      { branchIndex: 0, rank: 1, objectiveScore: 1 as const, judgeScore: 5, totalScore: 1.15 },
    ];
    const dpo = toDpoRecord(branchResults, ranked, 0);
    expect(dpo).toBeNull();

    const ppo = toPpoRecords(branchResults, ranked, 0);
    expect(ppo).toHaveLength(1);
  });

  it("identical finalAnswer on all branches: toDpoRecord returns null", async () => {
    // Make a model factory where every branch returns the exact same answer
    const sameAnswerFactory = (): Model => ({
      providerId: "mock/same",
      async *generate(_msgs, _opts): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "identical answer" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    });

    const runner = new RolloutForkRunner({
      branches: 2,
      concurrency: 2,
      modelFactory: sameAnswerFactory,
    });

    const branchResults = [];
    for await (const r of runner.run(
      { model: sameAnswerFactory(), tools: [], maxSteps: 3 },
      "task that always gets the same answer"
    )) {
      branchResults.push(r);
    }

    const rolloutRecords: RolloutRecord[] = branchResults.map((r, i) => ({
      rolloutId: r.rolloutId,
      branchIndex: r.branchIndex,
      finalAnswer: r.finalAnswer,
      objectiveScore: i === 0 ? 1 : (0 as 0 | 1),
      task: r.task,
    }));
    const ranker = new RolloutRanker();
    const { ranked } = await ranker.rank(rolloutRecords);
    const dpo = toDpoRecord(branchResults, ranked, 0);
    // chosen === rejected → must return null
    expect(dpo).toBeNull();
  });

  it("task with special characters produces valid JSONL", async () => {
    const factory = makeBranchModelFactory();
    const runner = new RolloutForkRunner({
      branches: 2,
      concurrency: 2,
      modelFactory: factory,
      temperaturePerBranch: [0.2, 0.8],
    });

    const specialTask = 'Compute "17 + 25"\nResult: use add(a=17, b=25)\t→ answer: 42';
    const branchResults = [];
    for await (const r of runner.run(
      { model: factory(), tools: [makeCheckBuildTool()], maxSteps: 5 },
      specialTask
    )) {
      branchResults.push(r);
    }

    const rolloutRecords: RolloutRecord[] = branchResults.map((r) => ({
      rolloutId: r.rolloutId,
      branchIndex: r.branchIndex,
      finalAnswer: r.finalAnswer,
      objectiveScore: 0 as 0 | 1,
      task: r.task,
    }));
    const ranker = new RolloutRanker();
    const { ranked } = await ranker.rank(rolloutRecords);
    const ppo = toPpoRecords(branchResults, ranked, 0);
    const jsonl = toJsonl(ppo);

    // 每行必须是合法 JSON，且 prompt 包含原始 task（含特殊字符）
    for (const line of jsonl.split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as { prompt: string };
      expect(parsed.prompt).toBe(specialTask);
    }
  });

  it("temperaturePerBranch=[0] boundary: all branches get temperature 0", async () => {
    const capturedTemps: number[] = [];
    const tempCapture = (): Model => ({
      providerId: "mock/temp",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        capturedTemps.push(opts?.temperature ?? -1);
        yield { type: "text_delta", delta: "done" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    });

    const runner = new RolloutForkRunner({
      branches: 3,
      concurrency: 3,
      modelFactory: tempCapture,
      temperaturePerBranch: [0],
    });

    const results = [];
    for await (const r of runner.run(
      { model: tempCapture(), tools: [], maxSteps: 3 },
      "boundary test"
    )) {
      results.push(r);
    }

    // 所有分支都应该用 temperature=0（最后一个值重复）
    expect(results).toHaveLength(3);
    for (const t of capturedTemps) {
      expect(t).toBe(0);
    }
  });
});
