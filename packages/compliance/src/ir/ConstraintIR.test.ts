/**
 * ConstraintIR / TaskSpec — unit tests.
 *
 * These are sanity checks for the Phase 0 scaffold: shape compatibility
 * with `@wasmagent/core` `Criterion`, Zod validation behaviour, and the
 * defaults. Real coverage of verifier dispatch and repair planning
 * lives in `verifier/` and `repair/` test files.
 */

import { describe, expect, test } from "bun:test";
import type { Criterion } from "@wasmagent/core";
import {
  type ConstraintIR,
  ConstraintIRSchema,
  DEFAULT_PRIORITY_HIERARCHY,
  parseTaskSpec,
  type TaskSpec,
  TaskSpecSchema,
} from "./ConstraintIR.js";

describe("ConstraintIR", () => {
  test("structurally extends @wasmagent/core Criterion", () => {
    // Type-level check: assigning a ConstraintIR into a Criterion must
    // compile. Runtime no-op; the assignment fails to typecheck if the
    // extends contract regresses.
    const ir: ConstraintIR = {
      id: "c1",
      description: "x",
      verify_method: "file_exists",
      path: "out.md",
      level: "hard",
      priority: 50,
      category: "format",
    };
    const c: Criterion = ir;
    expect(c.id).toBe("c1");
  });

  test("Zod schema accepts a minimal valid IR", () => {
    const ir = {
      id: "c1",
      description: "must have conclusion",
      verify_method: "file_contains",
      arg: "# Conclusion",
      path: "out.md",
      level: "hard",
      priority: 100,
      category: "format",
    };
    expect(() => ConstraintIRSchema.parse(ir)).not.toThrow();
  });

  test("Zod schema rejects unknown level", () => {
    const bad = {
      id: "c1",
      description: "",
      verify_method: "file_exists",
      level: "blocker", // not in enum
      priority: 0,
      category: "format",
    };
    expect(() => ConstraintIRSchema.parse(bad)).toThrow();
  });

  test("Zod schema preserves arbitrary verify_method strings", () => {
    // verify_method must stay open — custom verifiers register their
    // own method names at runtime.
    const ir = {
      id: "c1",
      description: "",
      verify_method: "custom_business_check_v3",
      level: "soft",
      priority: 10,
      category: "content",
    };
    expect(() => ConstraintIRSchema.parse(ir)).not.toThrow();
  });

  test("repair policy is optional and validated when present", () => {
    const ir = {
      id: "c1",
      description: "",
      verify_method: "file_exists",
      level: "hard",
      priority: 100,
      category: "format",
      repair: { strategy: "patch", max_rounds: 2 },
    };
    expect(() => ConstraintIRSchema.parse(ir)).not.toThrow();
  });
});

describe("TaskSpec", () => {
  const validSpec: TaskSpec = {
    id: "markdown-report.v1",
    intent: "produce_research_summary",
    language: "en",
    constraints: [
      {
        id: "c1",
        description: "must contain conclusion",
        verify_method: "file_contains",
        arg: "# Conclusion",
        path: "out.md",
        level: "hard",
        priority: 100,
        category: "format",
      },
    ],
    priority_hierarchy: ["system_policy", "user_explicit_constraints"],
  };

  test("parseTaskSpec accepts a minimal valid spec", () => {
    expect(() => parseTaskSpec(validSpec)).not.toThrow();
    const parsed = parseTaskSpec(validSpec);
    expect(parsed.id).toBe("markdown-report.v1");
    expect(parsed.constraints).toHaveLength(1);
  });

  test("parseTaskSpec rejects empty constraints array", () => {
    const bad = { ...validSpec, constraints: [] };
    expect(() => parseTaskSpec(bad)).toThrow();
  });

  test("parseTaskSpec rejects empty priority_hierarchy", () => {
    const bad = { ...validSpec, priority_hierarchy: [] };
    expect(() => parseTaskSpec(bad)).toThrow();
  });

  test("TaskSpecSchema validates tool policy when present", () => {
    const withTools: TaskSpec = {
      ...validSpec,
      tools: { allowed: ["web_search"], denied: ["shell_exec"] },
    };
    expect(() => TaskSpecSchema.parse(withTools)).not.toThrow();
  });

  test("DEFAULT_PRIORITY_HIERARCHY is the documented six-source default", () => {
    // Lock the order — downstream conflict resolvers assume this exact
    // sequence when a TaskSpec omits priority_hierarchy. Changing it
    // requires a Changeset entry.
    expect(DEFAULT_PRIORITY_HIERARCHY).toEqual([
      "system_policy",
      "user_explicit_constraints",
      "task_package_constraints",
      "tool_output_constraints",
      "history_constraints",
      "style_preferences",
    ]);
  });
});
