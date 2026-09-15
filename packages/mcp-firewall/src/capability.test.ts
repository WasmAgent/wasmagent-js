import { beforeEach, describe, expect, it } from "bun:test";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import {
  CapabilityRegistry,
  classifyEffect,
  detectCrossTenantAccess,
  makeCapabilityPolicyRule,
  makeTenantIsolationRule,
} from "./capability.js";
import { createRequestIdentity, MCPGateway } from "./gateway.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const EXEC_TOOL: McpToolEntry = {
  name: "execute_shell",
  description: "Execute a shell command",
  inputSchema: { type: "object" as const, properties: {} },
};

const PRINCIPAL = "agent-1";
const TENANT = "acme";

// ── classifyEffect ────────────────────────────────────────────────────────────

describe("classifyEffect", () => {
  it("CAP-01: tool name containing 'exec' or 'shell' → exec", () => {
    expect(classifyEffect("execute_shell", {})).toBe("exec");
  });

  it("CAP-02: arg value containing ~/.ssh path → read_secret", () => {
    expect(classifyEffect("read_file", { path: "~/.ssh/id_rsa" })).toBe("read_secret");
  });

  it("CAP-03: generic tool with safe args → read_only", () => {
    expect(classifyEffect("list_files", { dir: "/tmp" })).toBe("read_only");
  });
});

// ── makeCapabilityPolicyRule ──────────────────────────────────────────────────

describe("makeCapabilityPolicyRule", () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  it("CAP-04: capability not granted → deny for exec tools", () => {
    const rule = makeCapabilityPolicyRule(registry, PRINCIPAL, TENANT);
    const result = rule.evaluate("execute_shell", {}, null);
    expect(result).toBe("deny");
  });

  it("CAP-05: capability granted → no escalation (undefined)", () => {
    registry.grant({ principal: PRINCIPAL, tenant: TENANT, capability: "exec.shell" });
    const rule = makeCapabilityPolicyRule(registry, PRINCIPAL, TENANT);
    const result = rule.evaluate("execute_shell", {}, null);
    expect(result).toBeUndefined();
  });

  it("CAP-06: expired grant → treated as not granted → deny", () => {
    registry.grant({
      principal: PRINCIPAL,
      tenant: TENANT,
      capability: "exec.shell",
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    });
    const rule = makeCapabilityPolicyRule(registry, PRINCIPAL, TENANT);
    const result = rule.evaluate("execute_shell", {}, null);
    expect(result).toBe("deny");
  });
});

// ── detectCrossTenantAccess ───────────────────────────────────────────────────

describe("detectCrossTenantAccess", () => {
  it("CAP-07: /tenants/<other-org>/ pattern → cross-tenant detected", () => {
    expect(
      detectCrossTenantAccess({ url: "/tenants/other-org/data" }, "my-org")
    ).toBe(true);
  });

  it("CAP-08: no tenant pattern in args → false", () => {
    expect(
      detectCrossTenantAccess({ path: "/tmp/data.json" }, "my-org")
    ).toBe(false);
  });
});

// ── makeTenantIsolationRule ───────────────────────────────────────────────────

describe("makeTenantIsolationRule", () => {
  it("CAP-09: denies cross-tenant args", () => {
    const rule = makeTenantIsolationRule("agent-1", "my-org");
    const result = rule.evaluate("some_tool", { url: "/tenants/other-org/data" }, null);
    expect(result).toBe("deny");
  });

  it("CAP-10: allows same-tenant args", () => {
    const rule = makeTenantIsolationRule("agent-1", "my-org");
    const result = rule.evaluate("some_tool", { url: "/tenants/my-org/data" }, null);
    expect(result).toBeUndefined();
  });
});

// ── MCPGateway.evaluate capabilityEffect ──────────────────────────────────────

describe("MCPGateway.evaluate — capabilityEffect", () => {
  it("CAP-11: evaluate() returns capabilityEffect field matching tool heuristic", () => {
    const gw = new MCPGateway();
    const identity = createRequestIdentity({
      principal: "test-principal",
      sessionId: "session-1",
    });
    const decision = gw.evaluate({
      identity,
      serverId: "test-server",
      tool: EXEC_TOOL,
      args: {},
    });
    expect(decision.capabilityEffect).toBeDefined();
    expect(decision.capabilityEffect).toBe("exec");
  });
});
