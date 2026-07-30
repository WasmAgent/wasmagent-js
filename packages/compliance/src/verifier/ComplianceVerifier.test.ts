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

  // ── #302: verifyObject ────────────────────────────────────────────────────

  describe("ComplianceVerifier.verifyObject (static)", () => {
    const objSpec: TaskSpec = {
      id: "obj.v1",
      intent: "validate object",
      language: "en",
      constraints: [
        {
          id: "o1",
          description: "object.json must exist",
          verify_method: "file_exists",
          path: "object.json",
          level: "hard",
          priority: 100,
          category: "format",
        },
        {
          id: "o2",
          description: "object.json must contain status key",
          verify_method: "file_contains",
          arg: '"status"',
          path: "object.json",
          level: "hard",
          priority: 90,
          category: "format",
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };

    test("passes when object JSON satisfies all constraints", async () => {
      const draft = { id: "pr-42", status: "open", title: "feat: add API" };
      const result = await ComplianceVerifier.verifyObject(draft, objSpec);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.passing_constraint_ids).toContain("o1");
      expect(result.passing_constraint_ids).toContain("o2");
    });

    test("reports violation when object JSON does not satisfy a constraint", async () => {
      const draft = { id: "pr-42", title: "feat: add API" }; // missing "status"
      const result = await ComplianceVerifier.verifyObject(draft, objSpec);
      expect(result.ok).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.constraint_id).toBe("o2");
    });

    test("forwards stage option to violations", async () => {
      const draft = { id: "pr-42" }; // missing status
      const result = await ComplianceVerifier.verifyObject(draft, objSpec, {
        stage: "post_tool_call",
      });
      expect(result.violations[0]?.detected_at).toBe("post_tool_call");
    });

    test("forwards evidenceSpanHooks to violations", async () => {
      const draft = { id: "pr-42" }; // missing status
      const result = await ComplianceVerifier.verifyObject(draft, objSpec, {
        evidenceSpanHooks: {
          file_contains: (_ir, _hint) => ({
            region_id: "custom:span",
          }),
        },
      });
      expect(result.violations[0]?.evidence_span?.region_id).toBe("custom:span");
    });
  });

  describe("ComplianceVerifier#verifyObject (instance)", () => {
    const objSpec: TaskSpec = {
      id: "obj.inst.v1",
      intent: "validate object instance",
      language: "en",
      constraints: [
        {
          id: "i1",
          description: "object.json must contain amount",
          verify_method: "file_contains",
          arg: '"amount"',
          path: "object.json",
          level: "hard",
          priority: 80,
          category: "format",
        },
      ],
      priority_hierarchy: ["system_policy"],
    };

    test("passes for object that satisfies constraints", async () => {
      const ws = memoryWorkspace({});
      const pipeline = new VerificationPipeline({ ws, verifiers: [new DeterministicVerifier()] });
      const verifier = new ComplianceVerifier({ pipeline });
      const invoice = { invoiceId: "INV-001", amount: 5000, currency: "USD" };
      const result = await verifier.verifyObject(invoice, objSpec);
      expect(result.ok).toBe(true);
    });

    test("reports violation for object that fails constraint", async () => {
      const ws = memoryWorkspace({});
      const pipeline = new VerificationPipeline({ ws, verifiers: [new DeterministicVerifier()] });
      const verifier = new ComplianceVerifier({ pipeline });
      const invoice = { invoiceId: "INV-001", currency: "USD" }; // missing amount
      const result = await verifier.verifyObject(invoice, objSpec);
      expect(result.ok).toBe(false);
      expect(result.violations[0]?.constraint_id).toBe("i1");
    });

    test("uses registered evidenceSpanHooks from constructor", async () => {
      const ws = memoryWorkspace({});
      const pipeline = new VerificationPipeline({ ws, verifiers: [new DeterministicVerifier()] });
      const verifier = new ComplianceVerifier({
        pipeline,
        evidenceSpanHooks: {
          file_contains: (_ir, _hint) => ({ region_id: "instance:hook" }),
        },
      });
      const invoice = { invoiceId: "INV-001" }; // missing amount
      const result = await verifier.verifyObject(invoice, objSpec);
      expect(result.violations[0]?.evidence_span?.region_id).toBe("instance:hook");
    });
  });
});
