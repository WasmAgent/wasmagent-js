/**
 * ComplianceRun — end-to-end tests for all three modes.
 *
 * Uses scripted fake models so the tests are deterministic and don't
 * need a real LLM. The fake models encode the typical scenarios for
 * each mode (first-shot pass, retry-then-pass, repair-then-pass).
 */

import { describe, expect, test } from "bun:test";
import { DeterministicVerifier, VerificationPipeline, type WorkspaceReader } from "@wasmagent/core";
import type { GenerateOptions, Model, ModelMessage, StreamEvent } from "@wasmagent/core/models";
import type { TaskSpec } from "../ir/ConstraintIR.js";
import { FakeRepairLLM } from "../repair/RepairLLM.js";
import { RepairPlanner } from "../repair/RepairPlanner.js";
import { ComplianceVerifier } from "../verifier/ComplianceVerifier.js";
import { IFEvalVerifier } from "../verifier/ifeval/IFEvalVerifier.js";
import { ComplianceRun } from "./ComplianceRun.js";

function memoryWorkspace(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    reader: {
      async readFile(path) {
        const body = files.get(path);
        if (body === undefined) throw new Error(`no such file: ${path}`);
        return body;
      },
      async fileExists(path) {
        return files.has(path);
      },
      async fileSize(path) {
        const body = files.get(path);
        if (body === undefined) throw new Error(`no such file: ${path}`);
        return Buffer.byteLength(body, "utf8");
      },
    } satisfies WorkspaceReader,
    writer: {
      async writeFile(path: string, body: string) {
        files.set(path, body);
      },
    },
    files,
  };
}

/**
 * Scripted Model — emits a queued response for each generate() call.
 * Each call pops one response from the queue; if the queue is empty
 * the test fails with a clear error.
 */
function scriptedModel(responses: string[]): Model {
  const queue = [...responses];
  return {
    providerId: "test-fake",
    capabilities: {
      localEndpoint: true,
      metered: false,
      supportsGrammar: false,
      cacheStrategy: "none",
    },
    async *generate(
      _msgs: ModelMessage[],
      _opts: GenerateOptions = {}
    ): AsyncGenerator<StreamEvent> {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("scriptedModel: no more responses queued");
      }
      yield { type: "text_delta", delta: next };
      yield {
        type: "usage",
        usage: { inputTokens: 20, outputTokens: next.length } as never,
      };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

const spec: TaskSpec = {
  id: "ifeval.test.v1",
  intent: "ifeval_response",
  language: "en",
  constraints: [
    {
      id: "c1",
      description: "no commas allowed",
      verify_method: "ifeval:punctuation:no_comma",
      path: "r.txt",
      level: "hard",
      priority: 100,
      category: "format",
      repair: { strategy: "patch" },
    },
  ],
  priority_hierarchy: ["system_policy", "user_explicit_constraints"],
};

function makeVerifier(reader: WorkspaceReader) {
  const pipeline = new VerificationPipeline({
    ws: reader,
    verifiers: [new IFEvalVerifier(), new DeterministicVerifier()],
  });
  return new ComplianceVerifier({ pipeline });
}

describe("ComplianceRun — mode=direct", () => {
  test("passes when first generation is compliant", async () => {
    const ws = memoryWorkspace();
    const model = scriptedModel(["a clean response"]);
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "produce a clean response",
      artifact_path: "r.txt",
      model_id: "fake-clean",
      mode: "direct",
      model,
      verifier,
      writer: ws.writer,
    });
    const record = await run.execute();
    expect(record.final_pass).toBe(true);
    expect(record.violations).toHaveLength(0);
    expect(record.repair_trace).toHaveLength(0);
    expect(record.repair_rounds).toBe(0);
    expect(record.model).toBe("fake-clean");
    expect(record.mode).toBe("direct");
    expect(record.task_spec_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fails (no repair) when first generation has a violation", async () => {
    const ws = memoryWorkspace();
    const model = scriptedModel(["has, commas, here"]);
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "fake-dirty",
      mode: "direct",
      model,
      verifier,
      writer: ws.writer,
    });
    const record = await run.execute();
    expect(record.final_pass).toBe(false);
    expect(record.violations).toHaveLength(1);
    expect(record.repair_trace).toHaveLength(0);
  });
});

describe("ComplianceRun — mode=prompt_retry", () => {
  test("retries when first generation fails; passes when retry compliant", async () => {
    const ws = memoryWorkspace();
    const model = scriptedModel([
      "has, commas, here", // first attempt fails
      "clean retry text", //  retry passes
    ]);
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "fake-retry",
      mode: "prompt_retry",
      model,
      verifier,
      writer: ws.writer,
      max_retries: 3,
    });
    const record = await run.execute();
    expect(record.final_pass).toBe(true);
    expect(record.violations).toHaveLength(1); // initial violations recorded
    expect(record.repair_trace).toHaveLength(1);
    expect(record.repair_trace[0]?.strategy).toBe("full");
    expect(record.token_cost.repair).toBeGreaterThan(0);
  });

  test("gives up after max_retries", async () => {
    const ws = memoryWorkspace();
    const model = scriptedModel([
      "bad, one",
      "bad, two",
      "bad, three",
      "bad, four", // would-be 4th attempt, never used
    ]);
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "fake-stuck",
      mode: "prompt_retry",
      model,
      verifier,
      writer: ws.writer,
      max_retries: 2,
    });
    const record = await run.execute();
    expect(record.final_pass).toBe(false);
    expect(record.repair_trace[0]?.ok).toBe(false);
  });
});

describe("ComplianceRun — mode=full_pcl", () => {
  test("uses RepairPlanner to clear violations via patch", async () => {
    const ws = memoryWorkspace();
    // First generation has a comma; planner's PatchStrategy fixes it.
    const model = scriptedModel(["has, a, comma"]);
    const verifier = makeVerifier(ws.reader);
    // No LLM needed — PatchStrategy is deterministic.
    const planner = new RepairPlanner({ verifier, writer: ws.writer });
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "fake-pcl",
      mode: "full_pcl",
      model,
      verifier,
      writer: ws.writer,
      planner,
    });
    const record = await run.execute();
    expect(record.final_pass).toBe(true);
    expect(record.repair_trace).toHaveLength(1);
    expect(record.repair_trace[0]?.strategy).toBe("patch");
    expect(record.artifact).toBe("has a comma");
    // No LLM tokens spent on repair since PatchStrategy is deterministic.
    expect(record.token_cost.repair ?? 0).toBe(0);
  });

  test("escalates to regenerate_region when needed", async () => {
    const ws = memoryWorkspace();
    const model = scriptedModel(["a"]); // 1 word, way under the bound
    const wordSpec: TaskSpec = {
      ...spec,
      constraints: [
        {
          id: "c1",
          description: "≥10 words",
          verify_method: "ifeval:length_constraints:number_words",
          arg: { relation: "at least", num_words: 10 },
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
          repair: { strategy: "regenerate_region" },
        },
      ],
    };
    const verifier = makeVerifier(ws.reader);
    const llm = new FakeRepairLLM([
      {
        match: () => true,
        reply: "this is a sufficiently long response to satisfy the constraint at least ten words",
      },
    ]);
    const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
    const run = new ComplianceRun({
      spec: wordSpec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "fake-pcl-llm",
      mode: "full_pcl",
      model,
      verifier,
      writer: ws.writer,
      planner,
    });
    const record = await run.execute();
    expect(record.final_pass).toBe(true);
    expect(record.repair_trace[0]?.strategy).toBe("regenerate_region");
  });

  test("throws when planner missing and a violation needs repair", async () => {
    const ws = memoryWorkspace();
    // Response with a comma so the constraint fails and the run
    // attempts to enter the repair branch.
    const model = scriptedModel(["bad, response"]);
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "x",
      mode: "full_pcl",
      model,
      verifier,
      writer: ws.writer,
    });
    await expect(run.execute()).rejects.toThrow(/requires opts\.planner/);
  });
});

describe("ComplianceRun — error capture (defensive)", () => {
  // These tests pin down the contract that infrastructure failures
  // produce a RECORD (with `error` set), not an exception. Customers
  // running long sweeps need to see broken runs in their JSONL — not
  // discover them by counting missing entries.

  function throwingModel(stage: "generate"): Model {
    return {
      providerId: "throwing-fake",
      capabilities: {
        localEndpoint: true,
        metered: false,
        supportsGrammar: false,
        cacheStrategy: "none",
      },
      // Throws-before-yielding fake — simulates a model that fails to emit any
      // tokens (e.g. a connection error). Model.generate must keep the async*
      // signature for type compatibility with @wasmagent/core.
      // biome-ignore lint/correctness/useYield: intentional, see comment above.
      async *generate(): AsyncGenerator<StreamEvent> {
        throw new Error(`simulated ${stage} failure`);
      },
    };
  }

  test("model failure during initial generation → error record, no throw", async () => {
    const ws = memoryWorkspace();
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "broken-model",
      mode: "direct",
      model: throwingModel("generate"),
      verifier,
      writer: ws.writer,
    });
    const record = await run.execute();
    expect(record.error).toBeDefined();
    expect(record.error?.kind).toBe("model_error");
    expect(record.error?.stage).toBe("generate");
    expect(record.error?.message).toContain("simulated generate failure");
    expect(record.final_pass).toBe(false);
    expect(record.violations).toEqual([]);
    // The artifact is empty because we never got past generation.
    expect(record.artifact).toBe("");
    expect(record.task_id).toBe(spec.id);
  });

  test("model failure during prompt_retry repair → error record, retains initial violations", async () => {
    const ws = memoryWorkspace();
    let callCount = 0;
    const model: Model = {
      providerId: "flaky-fake",
      capabilities: {
        localEndpoint: true,
        metered: false,
        supportsGrammar: false,
        cacheStrategy: "none",
      },
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          // First call succeeds but with a violation
          yield { type: "text_delta", delta: "has, comma" };
          yield { type: "stop", stopReason: "end_turn" };
          return;
        }
        throw new Error("flaky model on retry");
      },
    };
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "flaky",
      mode: "prompt_retry",
      model,
      verifier,
      writer: ws.writer,
      max_retries: 3,
    });
    const record = await run.execute();
    expect(record.error).toBeDefined();
    expect(record.error?.kind).toBe("repair_error");
    expect(record.error?.stage).toBe("repair");
    // Initial violations are preserved.
    expect(record.violations).toHaveLength(1);
    expect(record.violations[0]?.constraint_id).toBe("c1");
    expect(record.final_pass).toBe(false);
  });

  test("workspace write failure → error record with workspace_error", async () => {
    const ws = memoryWorkspace();
    const brokenWriter = {
      async writeFile(): Promise<void> {
        throw new Error("disk full");
      },
    };
    const model = scriptedModel(["any response"]);
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "x",
      mode: "direct",
      model,
      verifier,
      writer: brokenWriter,
    });
    const record = await run.execute();
    expect(record.error?.kind).toBe("workspace_error");
    expect(record.error?.stage).toBe("write");
    expect(record.error?.message).toContain("disk full");
  });

  test("error.message is truncated to 1000 chars", async () => {
    const ws = memoryWorkspace();
    const longMessage = "x".repeat(2500);
    const model: Model = {
      providerId: "verbose-fake",
      capabilities: {
        localEndpoint: true,
        metered: false,
        supportsGrammar: false,
        cacheStrategy: "none",
      },
      // biome-ignore lint/correctness/useYield: throws-before-yielding, see earlier fake.
      async *generate(): AsyncGenerator<StreamEvent> {
        throw new Error(longMessage);
      },
    };
    const verifier = makeVerifier(ws.reader);
    const run = new ComplianceRun({
      spec,
      prompt: "x",
      artifact_path: "r.txt",
      model_id: "x",
      mode: "direct",
      model,
      verifier,
      writer: ws.writer,
    });
    const record = await run.execute();
    expect(record.error?.message.length).toBeLessThan(1100);
    expect(record.error?.message).toMatch(/\[truncated \d+ chars\]$/);
  });
});
