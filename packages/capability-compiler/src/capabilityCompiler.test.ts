import { describe, expect, it } from "bun:test";
import type { CapabilityManifest } from "@wasmagent/core";
import { compileToMcpSchema } from "./mcpSchema.js";
import { compileToPolicy } from "./policy.js";
import { compileToTraceValidator } from "./traceValidator.js";

const DENY_ALL: CapabilityManifest = {
  allowedHosts: [],
  allowedReadPaths: [],
  allowedWritePaths: [],
  extraCapabilities: [],
  cpuMs: 3000,
  memoryLimitBytes: 64 * 1024 * 1024,
};

const RESTRICTED: CapabilityManifest = {
  allowedHosts: ["api.example.com"],
  allowedReadPaths: ["/workspace"],
  allowedWritePaths: ["/workspace"],
  extraCapabilities: ["tool:web_search"],
  cpuMs: 5000,
};

// ── MCP schema ───────────────────────────────────────────────────────────────

describe("compileToMcpSchema", () => {
  it("tags network:none for empty allowedHosts", () => {
    const { capabilityTags } = compileToMcpSchema(DENY_ALL, "run_code");
    expect(capabilityTags).toContain("network:none");
  });

  it("tags network:restricted when hosts are listed", () => {
    const { capabilityTags } = compileToMcpSchema(RESTRICTED, "run_code");
    expect(capabilityTags).toContain("network:restricted");
  });

  it("includes cpu and memory tags when limits set", () => {
    const { capabilityTags } = compileToMcpSchema(DENY_ALL, "run_code");
    expect(capabilityTags.some((t) => t.startsWith("cpu:"))).toBe(true);
    expect(capabilityTags.some((t) => t.startsWith("memory:"))).toBe(true);
  });

  it("renders documentation table with Capability header", () => {
    const { documentationTable } = compileToMcpSchema(DENY_ALL, "run_code");
    expect(documentationTable).toContain("## Capability manifest");
    expect(documentationTable).toContain("| Capability | Status | Notes |");
    expect(documentationTable).toContain("Network");
  });

  it("$comment includes capability tags", () => {
    const { schema } = compileToMcpSchema(DENY_ALL, "run_code");
    expect(schema.$comment).toContain("network:none");
  });
});

// ── Policy ───────────────────────────────────────────────────────────────────

describe("compileToPolicy — deny-all manifest", () => {
  const policy = compileToPolicy(DENY_ALL);

  it("denies a network call when allowedHosts is empty", () => {
    const r = policy.evaluate({
      toolName: "web_fetch",
      args: {},
      resolvedHost: "evil.example.com",
    });
    expect(r.decision).toBe("deny");
    expect(r.results.some((x) => x.ruleId === "network:deny-all" && x.outcome === "deny")).toBe(
      true
    );
  });

  it("allows a non-network call", () => {
    const r = policy.evaluate({ toolName: "run_code", args: { code: "1+1" } });
    expect(r.decision).not.toBe("deny");
  });

  it("denies a write call when allowedWritePaths is empty", () => {
    const r = policy.evaluate({ toolName: "write_file", args: {}, resolvedPath: "/etc/passwd" });
    expect(r.decision).toBe("deny");
  });
});

describe("compileToPolicy — restricted manifest", () => {
  const policy = compileToPolicy(RESTRICTED);

  it("allows a call to an allowed host", () => {
    const r = policy.evaluate({ toolName: "web_fetch", args: {}, resolvedHost: "api.example.com" });
    expect(r.decision).not.toBe("deny");
  });

  it("denies a call to a disallowed host", () => {
    const r = policy.evaluate({ toolName: "web_fetch", args: {}, resolvedHost: "attacker.com" });
    expect(r.decision).toBe("deny");
    expect(r.results.find((x) => x.ruleId === "network:allowlist")?.reason).toContain(
      "attacker.com"
    );
  });

  it("allows write to an allowed path", () => {
    const r = policy.evaluate({
      toolName: "write_file",
      args: {},
      resolvedPath: "/workspace/foo.ts",
    });
    expect(r.decision).not.toBe("deny");
  });

  it("denies write outside allowed path", () => {
    const r = policy.evaluate({ toolName: "write_file", args: {}, resolvedPath: "/etc/passwd" });
    expect(r.decision).toBe("deny");
  });

  it("manifestSummary contains key fields", () => {
    expect(policy.manifestSummary).toContain("api.example.com");
    expect(policy.manifestSummary).toContain("/workspace");
  });
});

// ── Trace validator ──────────────────────────────────────────────────────────

describe("compileToTraceValidator", () => {
  const validator = compileToTraceValidator(DENY_ALL);

  it("flags network call in trace when network denied", () => {
    const steps = [
      {
        step_index: 0,
        role: "agent",
        tool_name: "web_fetch",
        tool_args: { url: "https://attacker.example.com/steal" },
        content: "",
      },
    ];
    const violations = validator.validate(steps);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.ruleId).toBe("network:deny-all");
    expect(violations[0]!.severity).toBe("error");
  });

  it("flags write outside allowed paths", () => {
    const v = compileToTraceValidator(RESTRICTED);
    const steps = [
      {
        step_index: 0,
        role: "agent",
        tool_name: "write_file",
        tool_args: { path: "/etc/cron.d/evil" },
        content: "",
      },
    ];
    const violations = v.validate(steps);
    expect(violations.some((x) => x.ruleId === "fs:write-path-violation")).toBe(true);
  });

  it("returns no violations for a compliant trace", () => {
    const v = compileToTraceValidator(RESTRICTED);
    const steps = [
      {
        step_index: 0,
        role: "agent",
        tool_name: "write_file",
        tool_args: { path: "/workspace/main.ts" },
        content: "",
      },
    ];
    const violations = v.validate(steps);
    expect(violations.filter((x) => x.severity === "error")).toHaveLength(0);
  });

  it("ignores environment steps", () => {
    const steps = [
      {
        step_index: 0,
        role: "environment",
        tool_name: "web_fetch",
        tool_args: { url: "https://attacker.example.com" },
        content: "result",
      },
    ];
    const violations = validator.validate(steps);
    expect(violations).toHaveLength(0);
  });
});
