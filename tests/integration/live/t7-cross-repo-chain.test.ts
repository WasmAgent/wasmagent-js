/**
 * T7 · Cross-repo chain: wasmagent-js → rollout-wire/v1 → evomerge datafactory
 *
 * End-to-end integration test with real models and real Python evomerge code.
 *
 * S1 — wasmagent-js rollout → rollout-wire/v1 JSONL → evomerge Python round-trip
 * S2 — bscode trajectoryExport format → evomerge Python round-trip
 * S3 — Schema drift detection: wasmagent vs evomerge rollout-wire schema
 *
 * Run: bun test tests/integration/live/t7-cross-repo-chain.test.ts
 *
 * Skipped when ANTHROPIC_AUTH_TOKEN is unset or placeholder.
 */

import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicModel } from "@wasmagent/core";
import type { RolloutBranchResult } from "@wasmagent/core/beta";
import { DEFAULT_REWARD_FUNCTIONS, RolloutForkRunner, RolloutRanker } from "@wasmagent/core/beta";

// ── Skip guard ────────────────────────────────────────────────────────────────

const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:6655/anthropic/";
const LIVE = !!TOKEN && !TOKEN.startsWith("sk-ant-placeholder");

const HAIKU_ID = "anthropic--claude-4.5-haiku";

function haiku() {
  return new AnthropicModel(HAIKU_ID, { apiKey: TOKEN!, baseURL: BASE_URL });
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const EVOMERGE_SRC = "/tmp/evomerge-public-repo/src";
const EVOMERGE_AVAILABLE = existsSync(EVOMERGE_SRC);
const LIVE_ROLLOUT_PATH = join(tmpdir(), "t7-live-rollout.jsonl");

// ── S1 — wasmagent-js rollout → JSONL → evomerge ─────────────────────────────

describe("T7-S1 · wasmagent-js rollout → rollout-wire/v1 JSONL → evomerge Python", () => {
  it.skipIf(!LIVE || !EVOMERGE_AVAILABLE)(
    "runs 2-branch Haiku rollout, serializes to rollout-wire/v1, evomerge loads it",
    async () => {
      const runner = new RolloutForkRunner({
        branches: 2,
        concurrency: 2,
        temperaturePerBranch: [0.0, 0.7],
      });

      const branches: RolloutBranchResult[] = [];
      for await (const r of runner.run(
        { model: haiku(), tools: [], maxSteps: 4 },
        "What is 3 + 4? Answer with just the number.",
        "t7-s1-rollout"
      )) {
        branches.push(r);
        console.log(`  T7-S1 branch ${r.branchIndex}: "${r.finalAnswer.slice(0, 60)}"`);
      }

      expect(branches.length).toBe(2);

      // Assign objective scores
      const withScores = branches.map((b) => ({
        ...b,
        objectiveScore: (b.finalAnswer.includes("7") ? 1 : 0) as 0 | 1,
      }));

      const ranker = new RolloutRanker({ rewardFunctions: DEFAULT_REWARD_FUNCTIONS });
      const ranked = await ranker.rank(
        withScores.map((b) => ({
          rolloutId: b.rolloutId,
          task: b.task,
          branchIndex: b.branchIndex,
          finalAnswer: b.finalAnswer,
          objectiveScore: b.objectiveScore,
        }))
      );

      expect(ranked.ranked.length).toBe(2);

      // Serialize as rollout-wire/v1 JSONL (evomerge load_rollouts compatible)
      const rolloutJsonl =
        branches
          .map((b) =>
            JSON.stringify({
              schema_version: "rollout-wire/v1",
              rollout_id: b.rolloutId,
              task: b.task,
              branch_index: b.branchIndex,
              temperature: b.temperature,
              session_id: b.sessionId,
              tool_call_sequence: b.toolCallSequence,
              final_answer: b.finalAnswer,
              build_result: null,
              objective_score:
                withScores.find((w) => w.branchIndex === b.branchIndex)?.objectiveScore ?? 0,
              rank: ranked.ranked.find((r) => r.branchIndex === b.branchIndex)?.rank ?? 0,
              total_score:
                ranked.ranked.find((r) => r.branchIndex === b.branchIndex)?.totalScore ?? 0,
            })
          )
          .join("\n") + "\n";

      writeFileSync(LIVE_ROLLOUT_PATH, rolloutJsonl);
      console.log(`  T7-S1 wrote ${LIVE_ROLLOUT_PATH} (${rolloutJsonl.length} bytes)`);

      // Write Python script to temp file to avoid `;` line-joining issues
      const pyScriptPath = join(tmpdir(), "t7-s1-evomerge.py");
      writeFileSync(
        pyScriptPath,
        [
          "import sys",
          `sys.path.insert(0, '${EVOMERGE_SRC}')`,
          "from datafactory.exporter import TrainingDataExporter",
          "e = TrainingDataExporter(eval_items_path=None)",
          `records = e.load_rollouts('${LIVE_ROLLOUT_PATH}')`,
          "dpo, ppo = e.export(records, mode='fixture')",
          "print(f'LOADED:{len(records)} DPO:{len(dpo)} PPO:{len(ppo)}')",
          "for p in ppo:",
          "    print(f'PPO branch={p.provenance[\"branch_index\"]} reward={p.reward:.2f}')",
          "if dpo:",
          '    print(f\'DPO chosen={dpo[0].provenance["chosen_branch"]} rejected={dpo[0].provenance["rejected_branch"]}\')',
        ].join("\n")
      );

      let pyOutput: string;
      try {
        pyOutput = execSync(`python3 "${pyScriptPath}"`, {
          encoding: "utf8",
          timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        console.error("Python stderr:", err.stderr);
        throw new Error(`Python failed: ${err.message}\nstderr: ${err.stderr}`);
      }

      console.log("  T7-S1 Python output:", pyOutput.trim());

      expect(pyOutput).toContain("LOADED:2");
      expect(pyOutput).toContain("PPO branch=");
      // Must produce 2 PPO records
      const ppoLines = pyOutput.split("\n").filter((l) => l.startsWith("PPO branch="));
      expect(ppoLines.length).toBe(2);
      // Each PPO line must have a valid reward
      for (const line of ppoLines) {
        const rewardStr = line.match(/reward=([0-9.]+)/)?.[1];
        expect(rewardStr).toBeDefined();
        const reward = parseFloat(rewardStr!);
        expect(reward).toBeGreaterThanOrEqual(0);
        expect(reward).toBeLessThanOrEqual(1.1); // small float tolerance
      }

      console.log("T7-S1 PASS — evomerge loaded", 2, "branches from wasmagent rollout");
    },
    120_000
  );
});

// ── S2 — bscode trajectoryExport format → evomerge ───────────────────────────

describe("T7-S2 · bscode trajectoryExport format → evomerge Python round-trip", () => {
  it("bscode rollout-wire/v1 records load correctly into evomerge (2 records, no crash)", async () => {
    // Dynamically import bscode trajectoryExport (JS build output)
    const bscodeExportPath = "/Users/I041705/github/bscode/apps/worker/src/trajectoryExport.js";

    let buildRolloutRecord: (opts: {
      jobId: string;
      jobSpec: { task: string };
      sessionId: string;
      branchIndex: number;
      buildResult: { status: string; ranAtMs: number } | null;
      toolCallSequence?: unknown[];
      finalAnswer?: string;
    }) => unknown;
    let bscodeToJsonl: (records: unknown[]) => string;

    try {
      const mod = await import(bscodeExportPath);
      buildRolloutRecord = mod.buildRolloutRecord;
      bscodeToJsonl = mod.toJsonl;
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.warn("T7-S2 SKIP: could not import bscode trajectoryExport:", err.message);
      // Not a hard failure — bscode may not be built
      return;
    }

    const r0 = buildRolloutRecord({
      jobId: "job-test00000001",
      jobSpec: { task: "add 3 and 4" },
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: { status: "success", ranAtMs: 1750000000000 },
    });

    const r1 = buildRolloutRecord({
      jobId: "job-test00000002",
      jobSpec: { task: "add 3 and 4" },
      sessionId: "session-12345678",
      branchIndex: 1,
      buildResult: { status: "failed", ranAtMs: 1750000000001 },
    });

    const jsonlStr = bscodeToJsonl([r0, r1]);
    expect(jsonlStr.trim().split("\n").length).toBe(2);

    const bscodeJsonlPath = join(tmpdir(), "t7-s2-bscode.jsonl");
    writeFileSync(bscodeJsonlPath, jsonlStr);

    // Verify bscode records have schema_version
    const lines = jsonlStr.trim().split("\n");
    for (const line of lines) {
      const rec = JSON.parse(line) as { schema_version: string; provenance: { source: string } };
      expect(rec.schema_version).toBe("rollout-wire/v1");
      expect(rec.provenance.source).toBe("bscode");
    }

    // Write Python script to temp file to avoid `;` line-joining issues
    const pyScriptPath2 = join(tmpdir(), "t7-s2-evomerge.py");
    writeFileSync(
      pyScriptPath2,
      [
        "import sys",
        `sys.path.insert(0, '${EVOMERGE_SRC}')`,
        "from datafactory.exporter import TrainingDataExporter",
        "e = TrainingDataExporter(eval_items_path=None)",
        `records = e.load_rollouts('${bscodeJsonlPath}')`,
        "print(f'BSCODE_LOADED:{len(records)}')",
        "for r in records:",
        "    print(f'rec branch={r.branch_index} score={r.objective_score} rank={r.rank}')",
      ].join("\n")
    );

    let pyOutput: string;
    try {
      pyOutput = execSync(`python3 "${pyScriptPath2}"`, {
        encoding: "utf8",
        timeout: 15_000,
      });
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      console.error("Python stderr:", err.stderr);
      throw new Error(`Python failed: ${err.message}`);
    }

    console.log("  T7-S2 Python output:", pyOutput.trim());
    expect(pyOutput).toContain("BSCODE_LOADED:2");

    const recLines = pyOutput.split("\n").filter((l) => l.startsWith("rec branch="));
    expect(recLines.length).toBe(2);
    console.log("T7-S2 PASS — evomerge loaded 2 bscode records");
  }, 30_000);
});

// ── S3 — Schema drift detection ───────────────────────────────────────────────

describe("T7-S3 · Schema drift detection: wasmagent vs evomerge rollout-wire.schema.json", () => {
  it("both schema copies have the same required fields for RolloutBranchRecord", () => {
    // Resolve the schema relative to this test file — process.cwd() varies
    // depending on whether the test is invoked from the repo root or from
    // tests/integration/ (turbo invokes from the package dir, which broke
    // the previous cwd-relative path).
    const wasmagentSchemaPath = createRequire(import.meta.url).resolve(
      "@wasmagent/protocol/schemas/compliance/rollout-wire.schema.json"
    );
    const evomergeSchemaPath = "/tmp/evomerge-public-repo/src/datafactory/rollout-wire.schema.json";

    // Skip if local evomerge clone isn't present (CI doesn't have it at /tmp)
    if (!existsSync(evomergeSchemaPath)) {
      console.log(
        "T7-S3 SKIP — evomerge schema not found at",
        evomergeSchemaPath,
        "(CI environment)"
      );
      return;
    }

    const wasmagentSchema = JSON.parse(readFileSync(wasmagentSchemaPath, "utf8")) as {
      $defs?: { RolloutBranchRecord?: { required?: string[] } };
    };
    const evomergeSchema = JSON.parse(readFileSync(evomergeSchemaPath, "utf8")) as {
      $defs?: { RolloutBranchRecord?: { required?: string[] } };
    };

    const wRequired: string[] = wasmagentSchema.$defs?.RolloutBranchRecord?.required ?? [];
    const eRequired: string[] = evomergeSchema.$defs?.RolloutBranchRecord?.required ?? [];

    console.log("  wasmagent required:", wRequired.sort().join(", "));
    console.log("  evomerge  required:", eRequired.sort().join(", "));

    // Both schemas must declare required fields
    expect(wRequired.length).toBeGreaterThan(0);
    expect(eRequired.length).toBeGreaterThan(0);

    // Sort for stable comparison
    const wSorted = [...wRequired].sort();
    const eSorted = [...eRequired].sort();

    // Find drift: fields in one but not the other
    const onlyInWasmagent = wSorted.filter((f) => !eRequired.includes(f));
    const onlyInEvomerge = eSorted.filter((f) => !wRequired.includes(f));

    if (onlyInWasmagent.length > 0 || onlyInEvomerge.length > 0) {
      console.error("SCHEMA DRIFT DETECTED:");
      if (onlyInWasmagent.length > 0)
        console.error("  Only in wasmagent:", onlyInWasmagent.join(", "));
      if (onlyInEvomerge.length > 0)
        console.error("  Only in evomerge:", onlyInEvomerge.join(", "));
    }

    expect(onlyInWasmagent).toEqual([]);
    expect(onlyInEvomerge).toEqual([]);

    console.log("T7-S3 PASS — schemas in sync, required fields:", wSorted.join(", "));
  });
});
