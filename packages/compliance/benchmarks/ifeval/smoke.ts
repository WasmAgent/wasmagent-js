#!/usr/bin/env bun
/**
 * Smoke test — single sample end-to-end through the real LocalModel.
 *
 * This is NOT a unit test (it loads a 1GB model and takes seconds to
 * run). It lives outside `src/` so `bun test` doesn't pick it up.
 *
 * Run with:
 *   bun packages/compliance/benchmarks/ifeval/smoke.ts
 *
 * What it does:
 *   1. Load Qwen2.5-1.5B-Instruct via @wasmagent/model-local
 *   2. Pick sample[0] from samples.jsonl
 *   3. Run all three modes (direct / prompt_retry / full_pcl)
 *   4. Print one-line per mode: pass/fail, repair rounds, tokens, latency
 *
 * Success criterion for the smoke: all three modes complete without
 * throwing. We do NOT assert pass/fail here — the goal is to confirm
 * the wiring; the 50-sample sweep is the experiment.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicVerifier, VerificationPipeline, type WorkspaceReader } from "@wasmagent/core";
import { LocalModel } from "@wasmagent/model-local";
import { RepairPlanner, type WorkspaceWriter } from "../../src/repair/RepairPlanner.js";
import {
  type ComplianceEvalRecord,
  ComplianceRun,
  type RunMode,
} from "../../src/runner/ComplianceRun.js";
import { ModelRepairLLM } from "../../src/runner/ModelRepairLLM.js";
import { ComplianceVerifier } from "../../src/verifier/ComplianceVerifier.js";
import { IFEvalVerifier } from "../../src/verifier/ifeval/IFEvalVerifier.js";
import { loadIFEvalSamples } from "./load.js";

const MODEL_ID = "qwen2.5-1.5b";
const SAMPLES_PATH = join(import.meta.dir, "samples.jsonl");

/** Disk-backed workspace under a tmpdir, scoped per run. */
function diskWorkspace(rootDir: string) {
  mkdirSync(rootDir, { recursive: true });
  const reader: WorkspaceReader = {
    async readFile(path) {
      return readFileSync(join(rootDir, path), "utf8");
    },
    async fileExists(path) {
      try {
        readFileSync(join(rootDir, path));
        return true;
      } catch {
        return false;
      }
    },
    async fileSize(path) {
      return readFileSync(join(rootDir, path)).byteLength;
    },
  };
  const writer: WorkspaceWriter = {
    async writeFile(path, body) {
      writeFileSync(join(rootDir, path), body, "utf8");
    },
  };
  return { reader, writer };
}

function fmt(record: ComplianceEvalRecord): string {
  const tokens =
    (record.token_cost.prompt ?? 0) +
    (record.token_cost.generation ?? 0) +
    (record.token_cost.repair ?? 0);
  return [
    `pass=${record.final_pass}`,
    `rounds=${record.repair_rounds}`,
    `tokens=${tokens}`,
    `ms=${record.latency_ms}`,
    `viol=${record.violations.length}`,
  ].join("  ");
}

async function main() {
  console.log(`# Smoke test — ${MODEL_ID} × IFEval sample[0]`);
  console.log();

  const tasks = loadIFEvalSamples(SAMPLES_PATH);
  if (tasks.length === 0) {
    console.error("no samples loaded — check samples.jsonl");
    process.exit(1);
  }
  // Hand-picked index. Default 3 = key=32 "Write a limerick … Don't use
  // commas" — a single, simple no-comma constraint that exercises the
  // PatchStrategy without depending on the model satisfying multi-class
  // requirements. Override via `SMOKE_INDEX` env var when iterating.
  const idx = Number(process.env.SMOKE_INDEX ?? "3");
  const task = tasks[idx];
  if (!task) {
    console.error(`SMOKE_INDEX=${idx} out of range; have ${tasks.length} samples`);
    process.exit(1);
  }
  console.log(`Sample key=${task.sample.key}`);
  console.log(`Constraints: ${task.spec.constraints.map((c) => c.verify_method).join(", ")}`);
  console.log(
    `Prompt: ${task.sample.prompt.slice(0, 120)}${task.sample.prompt.length > 120 ? "..." : ""}`
  );
  console.log();

  const model = new LocalModel({ source: { model: "qwen2.5-1.5b" } });
  console.log("Loading model...");
  const t0 = performance.now();
  await model.load();
  console.log(`  loaded in ${Math.round(performance.now() - t0)}ms`);
  console.log();

  for (const mode of ["direct", "prompt_retry", "full_pcl"] as RunMode[]) {
    const rootDir = mkdtempSync(join(tmpdir(), `compliance-smoke-${mode}-`));
    const ws = diskWorkspace(rootDir);
    const pipeline = new VerificationPipeline({
      ws: ws.reader,
      verifiers: [new IFEvalVerifier(), new DeterministicVerifier()],
    });
    const verifier = new ComplianceVerifier({ pipeline });

    const runOpts = {
      spec: task.spec,
      prompt: task.sample.prompt,
      artifact_path: task.responsePath,
      model_id: MODEL_ID,
      mode,
      model,
      verifier,
      writer: ws.writer,
      max_tokens: 512,
      temperature: 0.2,
    };

    let record: ComplianceEvalRecord;
    try {
      if (mode === "full_pcl") {
        const llm = new ModelRepairLLM({ model });
        const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
        record = await new ComplianceRun({ ...runOpts, planner }).execute();
      } else {
        record = await new ComplianceRun(runOpts).execute();
      }
    } catch (e) {
      console.log(`${mode.padEnd(14)}  ERROR: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    console.log(`${mode.padEnd(14)}  ${fmt(record)}`);
    console.log(`  artifact (first 200): ${JSON.stringify(record.artifact.slice(0, 200))}`);
  }
}

await main();
