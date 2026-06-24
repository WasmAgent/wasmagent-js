import { describe, expect, test } from "bun:test";
import { DeterministicVerifier, VerificationPipeline, type WorkspaceReader } from "@wasmagent/core";
import type { TaskSpec } from "../ir/ConstraintIR.js";
import { ComplianceVerifier } from "./ComplianceVerifier.js";

/**
 * Minimal in-memory workspace for tests. Mirrors the WorkspaceReader
 * contract from `@wasmagent/core`.
 */
function memoryWorkspace(files: Record<string, string>): WorkspaceReader {
  return {
    async readFile(path) {
      const body = files[path];
      if (body === undefined) throw new Error(`no such file: ${path}`);
      return body;
    },
    async fileExists(path) {
      return Object.hasOwn(files, path);
    },
    async fileSize(path) {
      const body = files[path];
      if (body === undefined) throw new Error(`no such file: ${path}`);
      return Buffer.byteLength(body, "utf8");
    },
  };
}

const spec: TaskSpec = {
  id: "test.v1",
  intent: "test",
  language: "en",
  constraints: [
    {
      id: "c1",
      description: "out.md must exist",
      verify_method: "file_exists",
      path: "out.md",
      level: "hard",
      priority: 100,
      category: "format",
    },
    {
      id: "c2",
      description: "out.md must contain Conclusion",
      verify_method: "file_contains",
      arg: "# Conclusion",
      path: "out.md",
      level: "hard",
      priority: 90,
      category: "format",
    },
  ],
  priority_hierarchy: ["system_policy", "user_explicit_constraints"],
};

describe("ComplianceVerifier", () => {
  test("returns ok when all constraints pass", async () => {
    const ws = memoryWorkspace({ "out.md": "# Conclusion\nAll good." });
    const pipeline = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const verifier = new ComplianceVerifier({ pipeline });
    const result = await verifier.verify(spec);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.passing_constraint_ids).toEqual(["c1", "c2"]);
  });

  test("collects violations with default evidence_span when constraints fail", async () => {
    const ws = memoryWorkspace({ "out.md": "no conclusion here" });
    const pipeline = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const verifier = new ComplianceVerifier({ pipeline });
    const result = await verifier.verify(spec);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    const [v] = result.violations;
    expect(v?.constraint_id).toBe("c2");
    expect(v?.level).toBe("hard");
    expect(v?.category).toBe("format");
    expect(v?.detected_at).toBe("post_decode");
    // Default span uses the path.
    expect(v?.evidence_span?.region_id).toBe("path:out.md");
    expect(result.passing_constraint_ids).toEqual(["c1"]);
  });

  test("uses a registered evidenceSpanHook when present", async () => {
    const ws = memoryWorkspace({ "out.md": "no conclusion here" });
    const pipeline = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const verifier = new ComplianceVerifier({
      pipeline,
      evidenceSpanHooks: {
        file_contains: (ir, _hint) => ({
          region_id: `section:${String(ir.arg).replace(/^#\s*/, "")}`,
          line_range: [1, 1],
        }),
      },
    });
    const result = await verifier.verify(spec);
    const [v] = result.violations;
    expect(v?.evidence_span?.region_id).toBe("section:Conclusion");
    expect(v?.evidence_span?.line_range).toEqual([1, 1]);
  });

  test("records the stage passed by the caller", async () => {
    const ws = memoryWorkspace({});
    const pipeline = new VerificationPipeline({
      ws,
      verifiers: [new DeterministicVerifier()],
    });
    const verifier = new ComplianceVerifier({ pipeline });
    const result = await verifier.verify(spec, { stage: "post_tool_call" });
    expect(result.violations.every((v) => v.detected_at === "post_tool_call")).toBe(true);
  });
});
