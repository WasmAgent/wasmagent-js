import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ToolDefinition } from "../tools/types.js";
import { ApprovalPolicy, applyApprovalPolicy, PolicyPresets } from "./approvalPolicy.js";

// Minimal fake write_file tool for testing applyApprovalPolicy
function fakeWriteTool(): ToolDefinition<{ path: string; content: string }, string> {
  return {
    name: "write_file",
    description: "Write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: true,
    forward: async () => "ok",
  };
}

function fakePatchTool(): ToolDefinition<{ path: string; patch: string }, string> {
  return {
    name: "patch_file",
    description: "Patch a file",
    inputSchema: z.object({ path: z.string(), patch: z.string() }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async () => "ok",
  };
}

function fakeDeleteTool(): ToolDefinition<{ path: string }, string> {
  return {
    name: "delete_file",
    description: "Delete a file",
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: true,
    forward: async () => "ok",
  };
}

describe("ApprovalPolicy", () => {
  it("defaultVerdict=allow — no rules → nothing requires approval", () => {
    const p = new ApprovalPolicy({ rules: [], defaultVerdict: "allow" });
    expect(p.needsApproval({ op: "write", path: "src/x.ts", sizeChars: 100 })).toBe(false);
  });

  it("defaultVerdict=require — no rules → everything requires approval", () => {
    const p = new ApprovalPolicy({ rules: [], defaultVerdict: "require" });
    expect(p.needsApproval({ op: "write", path: "src/x.ts", sizeChars: 100 })).toBe(true);
  });

  it("first matching rule wins; later rules don't override", () => {
    const p = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [
        { id: "allow-src", match: { paths: ["src/"] }, verdict: "allow" },
        { id: "require-all-writes", match: { op: "write" }, verdict: "require" },
      ],
    });
    // src/ path matches first rule (allow) — short-circuits
    expect(p.needsApproval({ op: "write", path: "src/foo.ts", sizeChars: 0 })).toBe(false);
    // non-src path hits second rule (require)
    expect(p.needsApproval({ op: "write", path: "lib/foo.ts", sizeChars: 0 })).toBe(true);
  });

  it("path matching does not do bare prefix — 'submit' should NOT match 'submit_pr'", () => {
    const p = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "gate-submit", match: { paths: ["submit"] }, verdict: "require" }],
    });
    // Exact match triggers
    expect(p.needsApproval({ op: "write", path: "submit", sizeChars: 0 })).toBe(true);
    // Directory child triggers
    expect(p.needsApproval({ op: "write", path: "submit/foo.ts", sizeChars: 0 })).toBe(true);
    // Bare prefix must NOT match a different path that starts with the same characters
    expect(p.needsApproval({ op: "write", path: "submit_pr", sizeChars: 0 })).toBe(false);
    expect(p.needsApproval({ op: "write", path: "submit_pr/foo", sizeChars: 0 })).toBe(false);
  });

  it("path ending with '/' matches anything under that directory prefix", () => {
    const p = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "gate-dir", match: { paths: [".github/"] }, verdict: "require" }],
    });
    expect(p.needsApproval({ op: "write", path: ".github/workflows/ci.yml", sizeChars: 0 })).toBe(
      true
    );
    expect(p.needsApproval({ op: "write", path: ".github/", sizeChars: 0 })).toBe(true);
    expect(p.needsApproval({ op: "write", path: ".githubx/foo", sizeChars: 0 })).toBe(false);
  });

  it("minSizeChars rule fires only when size threshold is met", () => {
    const p = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "large", match: { op: "write", minSizeChars: 1000 }, verdict: "require" }],
    });
    expect(p.needsApproval({ op: "write", path: "x.ts", sizeChars: 999 })).toBe(false);
    expect(p.needsApproval({ op: "write", path: "x.ts", sizeChars: 1000 })).toBe(true);
  });

  it("explain() surfaces the matched rule id", () => {
    const p = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "env-guard", match: { paths: [".env"] }, verdict: "require" }],
    });
    expect(p.explain({ op: "write", path: ".env", sizeChars: 0 }).ruleId).toBe("env-guard");
    expect(p.explain({ op: "write", path: "src/x.ts", sizeChars: 0 }).ruleId).toBeNull();
  });
});

describe("PolicyPresets", () => {
  it("permissive — write to any path is allowed", () => {
    const p = PolicyPresets.permissive();
    expect(p.needsApproval({ op: "write", path: ".env", sizeChars: 0 })).toBe(false);
    expect(p.needsApproval({ op: "delete", path: "critical.ts", sizeChars: 0 })).toBe(false);
  });

  it("strict — every write requires approval", () => {
    const p = PolicyPresets.strict();
    expect(p.needsApproval({ op: "write", path: "src/x.ts", sizeChars: 1 })).toBe(true);
    expect(p.needsApproval({ op: "patch", path: "src/x.ts", sizeChars: 1 })).toBe(true);
  });

  it("balanced — small source writes are free", () => {
    const p = PolicyPresets.balanced();
    expect(p.needsApproval({ op: "write", path: "src/feature.ts", sizeChars: 100 })).toBe(false);
  });

  it("balanced — dotfiles require approval", () => {
    const p = PolicyPresets.balanced();
    expect(p.needsApproval({ op: "write", path: ".env", sizeChars: 10 })).toBe(true);
    expect(p.needsApproval({ op: "write", path: ".env.production", sizeChars: 10 })).toBe(true);
    expect(p.needsApproval({ op: "write", path: ".github/workflows/ci.yml", sizeChars: 10 })).toBe(
      true
    );
  });

  it("balanced — large writes require approval", () => {
    const p = PolicyPresets.balanced();
    expect(p.needsApproval({ op: "write", path: "src/big.ts", sizeChars: 5_001 })).toBe(true);
    expect(p.needsApproval({ op: "write", path: "src/small.ts", sizeChars: 4_999 })).toBe(false);
  });

  it("balanced — delete always requires approval", () => {
    const p = PolicyPresets.balanced();
    expect(p.needsApproval({ op: "delete", path: "src/x.ts", sizeChars: 0 })).toBe(true);
    expect(p.needsApproval({ op: "rename", path: "src/x.ts", sizeChars: 0 })).toBe(true);
  });
});

describe("applyApprovalPolicy", () => {
  it("wraps write_file with needsApproval driven by policy", () => {
    const policy = PolicyPresets.strict();
    const [wrapped] = applyApprovalPolicy(policy, [fakeWriteTool()]);
    expect(typeof wrapped?.needsApproval).toBe("function");
    // strict — should require approval
    expect(
      (wrapped?.needsApproval as (i: unknown) => boolean)({ path: "x.ts", content: "hi" })
    ).toBe(true);
  });

  it("wraps patch_file, delete_file", () => {
    const policy = PolicyPresets.balanced();
    const tools = applyApprovalPolicy(policy, [fakePatchTool(), fakeDeleteTool()]);
    const patch = tools[0];
    const del = tools[1];
    // patch to non-dotfile with small delta is free
    expect(
      (patch?.needsApproval as (i: unknown) => boolean)({ path: "src/x.ts", patch: "fix" })
    ).toBe(false);
    // delete always requires approval in balanced
    expect((del?.needsApproval as (i: unknown) => boolean)({ path: "src/x.ts" })).toBe(true);
  });

  it("passes through non-write tools unchanged", () => {
    const readTool: ToolDefinition<{ path: string }, string> = {
      name: "read_file",
      description: "Read",
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => "content",
    };
    const [wrapped] = applyApprovalPolicy(PolicyPresets.strict(), [readTool]);
    expect(wrapped?.needsApproval).toBeUndefined();
  });
});
