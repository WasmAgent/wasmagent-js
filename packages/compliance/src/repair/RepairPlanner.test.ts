/**
 * RepairPlanner — end-to-end tests.
 *
 * These tests exercise the full loop: real IFEvalVerifier, real
 * strategies, fake LLM. The round-trip property under test is:
 *
 *   violation → repair → re-verify → violation gone
 *
 * For the deterministic strategies (patch, insert_section), this is a
 * tight loop with no model. For regenerate_region, the FakeRepairLLM
 * is configured to return text that *will* satisfy the verifier — the
 * planner doesn't care that it's not a real model.
 */

import { describe, expect, test } from "bun:test";
import { DeterministicVerifier, VerificationPipeline, type WorkspaceReader } from "@wasmagent/core";
import type { TaskSpec } from "../ir/ConstraintIR.js";
import { ComplianceVerifier } from "../verifier/ComplianceVerifier.js";
import { IFEvalVerifier } from "../verifier/ifeval/IFEvalVerifier.js";
import { FakeRepairLLM } from "./RepairLLM.js";
import { RepairPlanner, type WorkspaceWriter } from "./RepairPlanner.js";

/**
 * Mutable in-memory workspace. Implements both reader and writer so a
 * single instance can serve the verifier and the planner.
 */
function memoryWorkspace(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const reader: WorkspaceReader = {
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
  };
  const writer: WorkspaceWriter = {
    async writeFile(path, body) {
      files.set(path, body);
    },
  };
  return { reader, writer, files };
}

function makeVerifier(reader: WorkspaceReader) {
  const pipeline = new VerificationPipeline({
    ws: reader,
    verifiers: [new IFEvalVerifier(), new DeterministicVerifier()],
  });
  return new ComplianceVerifier({ pipeline });
}

describe("RepairPlanner", () => {
  test("PatchStrategy clears a no_comma violation in one round", async () => {
    const ws = memoryWorkspace({ "r.txt": "hello, world" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t1",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "no commas",
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
    const initialVerification = await verifier.verify(spec);
    expect(initialVerification.ok).toBe(false);

    const planner = new RepairPlanner({ verifier, writer: ws.writer });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "hello, world",
      initial_violations: initialVerification.violations,
    });

    expect(result.final_pass).toBe(true);
    expect(result.artifact).toBe("hello world");
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.strategy).toBe("patch");
    expect(result.trace[0]?.ok).toBe(true);
  });

  test("InsertSectionStrategy adds <<title>> when missing", async () => {
    const ws = memoryWorkspace({ "r.txt": "body only" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t2",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "must include <<title>>",
          verify_method: "ifeval:detectable_format:title",
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
          repair: { strategy: "insert_section" },
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const init = await verifier.verify(spec);
    expect(init.ok).toBe(false);

    const planner = new RepairPlanner({ verifier, writer: ws.writer });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "body only",
      initial_violations: init.violations,
    });
    expect(result.final_pass).toBe(true);
    expect(result.artifact).toMatch(/<<untitled>>/);
    expect(result.trace[0]?.strategy).toBe("insert_section");
  });

  test("RegenerateRegionStrategy uses LLM to satisfy word-count constraint", async () => {
    const ws = memoryWorkspace({ "r.txt": "too short" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t3",
      intent: "ifeval_response",
      language: "en",
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
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const init = await verifier.verify(spec);
    expect(init.ok).toBe(false);

    const llm = new FakeRepairLLM([
      {
        match: () => true,
        reply: "this is a deliberately long response with more than ten distinct words in it",
        usage: { prompt_tokens: 80, completion_tokens: 15 },
      },
    ]);
    const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "too short",
      initial_violations: init.violations,
    });
    expect(result.final_pass).toBe(true);
    expect(result.trace[0]?.strategy).toBe("regenerate_region");
    expect(result.trace[0]?.token_cost?.prompt).toBe(80);
    expect(result.trace[0]?.token_cost?.generation).toBe(15);
  });

  test("escalates from patch → regenerate_region when patch can't help", async () => {
    // Word-count constraint marked as `patch`, which the PatchStrategy
    // doesn't handle. Planner should escalate to regenerate_region.
    const ws = memoryWorkspace({ "r.txt": "two words" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t4",
      intent: "ifeval_response",
      language: "en",
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
          repair: { strategy: "patch" }, // wrong strategy on purpose
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const init = await verifier.verify(spec);
    const llm = new FakeRepairLLM([
      {
        match: () => true,
        reply: "this rewritten response contains many more than ten ordinary words now",
      },
    ]);
    const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "two words",
      initial_violations: init.violations,
    });
    expect(result.final_pass).toBe(true);
    // First round: patch (null artifact, ok=false). Second round:
    // either insert_section (null) or regenerate_region.
    expect(result.trace.length).toBeGreaterThanOrEqual(2);
    const strategies = result.trace.map((t) => t.strategy);
    expect(strategies).toContain("patch");
    expect(strategies).toContain("regenerate_region");
  });

  test("stops at max_rounds when violations remain", async () => {
    // Constraint that the LLM refuses to satisfy. The planner should
    // give up after max_rounds rather than loop forever.
    const ws = memoryWorkspace({ "r.txt": "x" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t5",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "≥100 words",
          verify_method: "ifeval:length_constraints:number_words",
          arg: { relation: "at least", num_words: 100 },
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
          repair: { strategy: "regenerate_region" },
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
      repair: { max_rounds: 2, default_strategy: "regenerate_region" },
    };
    const init = await verifier.verify(spec);
    const llm = new FakeRepairLLM([
      // Always returns short text — verifier never satisfied.
      { match: () => true, reply: "still short" },
    ]);
    const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "x",
      initial_violations: init.violations,
    });
    expect(result.final_pass).toBe(false);
    expect(result.trace.length).toBeLessThanOrEqual(2);
    expect(result.remaining_hard_violations).toHaveLength(1);
  });

  test("repairs multiple violations across rounds", async () => {
    // Two violations: one patchable (no_comma), one needing LLM (≥10 words).
    const ws = memoryWorkspace({ "r.txt": "hi, two" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t6",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "no commas",
          verify_method: "ifeval:punctuation:no_comma",
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
          repair: { strategy: "patch" },
        },
        {
          id: "c2",
          description: "≥10 words",
          verify_method: "ifeval:length_constraints:number_words",
          arg: { relation: "at least", num_words: 10 },
          path: "r.txt",
          level: "hard",
          priority: 90,
          category: "format",
          repair: { strategy: "regenerate_region" },
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const init = await verifier.verify(spec);
    expect(init.violations).toHaveLength(2);
    // LLM rewrites to a long response with no commas.
    const llm = new FakeRepairLLM([
      {
        match: () => true,
        reply:
          "this rewritten response has many more than ten ordinary words and no punctuation issues",
      },
    ]);
    const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "hi, two",
      initial_violations: init.violations,
    });
    expect(result.final_pass).toBe(true);
    // Both constraints satisfied.
    expect(result.remaining_hard_violations).toHaveLength(0);
    // First round handles c1 (priority 100) via patch.
    expect(result.trace[0]?.violation_ids).toContain("c1");
  });

  test("returns trace with no rounds when nothing to repair", async () => {
    const ws = memoryWorkspace({ "r.txt": "fine" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t7",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "no commas",
          verify_method: "ifeval:punctuation:no_comma",
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const planner = new RepairPlanner({ verifier, writer: ws.writer });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "fine",
      initial_violations: [], // nothing wrong
    });
    expect(result.final_pass).toBe(true);
    expect(result.trace).toHaveLength(0);
  });

  test("rolls back when LLM rewrite breaks a previously-passing constraint", async () => {
    // Setup: response violates ONLY the word-count constraint. After
    // a regenerate_region round, the LLM produces text that satisfies
    // word count but re-introduces a comma — which would NEWLY fail
    // the no_comma constraint. The planner must roll back.
    const ws = memoryWorkspace({ "r.txt": "two two two two two two two two two two two" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t-rollback",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "no commas",
          verify_method: "ifeval:punctuation:no_comma",
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
          repair: { strategy: "patch" },
        },
        {
          id: "c2",
          description: "≥20 words",
          verify_method: "ifeval:length_constraints:number_words",
          arg: { relation: "at least", num_words: 20 },
          path: "r.txt",
          level: "hard",
          priority: 90,
          category: "format",
          repair: { strategy: "regenerate_region" },
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    // The initial artifact: 11 commaless words → only c2 fails.
    const init = await verifier.verify(spec);
    expect(init.violations.map((v) => v.constraint_id)).toEqual(["c2"]);

    const llm = new FakeRepairLLM([
      {
        match: () => true,
        // 25 words but contains commas → would re-break c1.
        reply:
          "a much, longer, response, that, has, more than, twenty, words, in it now and definitely meets the minimum count, easily",
      },
    ]);
    const planner = new RepairPlanner({ verifier, writer: ws.writer, llm });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "two two two two two two two two two two two",
      initial_violations: init.violations,
    });
    // Round 1: regenerate_region returns commas → rolled back.
    expect(result.trace[0]?.strategy).toBe("regenerate_region");
    expect(result.trace[0]?.rolled_back).toBe(true);
    expect(result.trace[0]?.ok).toBe(false);
    // The artifact stays at the pre-round value (the commaless source).
    expect(result.artifact).not.toContain(",");
    // c2 is still unrepaired (planner escalates next iteration), but
    // c1 was preserved by the rollback.
    const remainingIds = result.remaining_hard_violations.map((v) => v.constraint_id);
    expect(remainingIds).not.toContain("c1");
  });

  test("does not roll back when a violation was already failing pre-round", async () => {
    // Both constraints failing on the initial artifact. Round 1 only
    // clears c1; c2 stays failing — this is NOT a regression.
    const ws = memoryWorkspace({ "r.txt": "a, b" });
    const verifier = makeVerifier(ws.reader);
    const spec: TaskSpec = {
      id: "t-no-rollback",
      intent: "ifeval_response",
      language: "en",
      constraints: [
        {
          id: "c1",
          description: "no commas",
          verify_method: "ifeval:punctuation:no_comma",
          path: "r.txt",
          level: "hard",
          priority: 100,
          category: "format",
          repair: { strategy: "patch" },
        },
        {
          id: "c2",
          description: "≥50 words",
          verify_method: "ifeval:length_constraints:number_words",
          arg: { relation: "at least", num_words: 50 },
          path: "r.txt",
          level: "hard",
          priority: 90,
          category: "format",
          repair: { strategy: "regenerate_region" },
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const init = await verifier.verify(spec);
    // The LLM is never called because patch handles c1 first; c2
    // would escalate but we cap rounds to 1 to keep the assertion
    // narrow.
    const planner = new RepairPlanner({
      verifier,
      writer: ws.writer,
      max_rounds: 1,
    });
    const result = await planner.repair({
      spec,
      artifact_path: "r.txt",
      initial_artifact: "a, b",
      initial_violations: init.violations,
    });
    expect(result.trace[0]?.strategy).toBe("patch");
    expect(result.trace[0]?.rolled_back).toBeUndefined();
    expect(result.trace[0]?.ok).toBe(true);
    expect(result.artifact).toBe("a b"); // commas removed
  });
});
