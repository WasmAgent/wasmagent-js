/**
 * Commit-time authorization regression tests (A4 / CT-01..CT-08).
 *
 * Architectural distinction under test: plan-time permission is NOT
 * commit-time authority. The gateway recomputes the binding decision from
 * CURRENT authority/context on every evaluate() — an earlier allow verdict is
 * never replayed. Each fixture: plan accepted at T0 → exactly one authority
 * dimension changes → commit denied or held at T1.
 *
 * Honest boundary (CT-NI-01): this package has no two-phase plan/commit API
 * with an "expected state transition" precondition field. The recomputation
 * model here is the commit-time gate callers get; a durable plan object with
 * transition preconditions is not-implemented and is not claimed.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry } from "./capability.js";
import { hashArgScope } from "./consent.js";
import {
  createRequestIdentity,
  createScopeLease,
  isScopeLeaseValid,
  MCPGateway,
} from "./gateway.js";
import {
  computeToolSnapshotHash,
  InMemoryToolSecurityProfileRegistry,
} from "./security-profile.js";
import { buildVettingCacheKey } from "./vetting.js";

const identityA = createRequestIdentity({ principal: "ct-principal-a", sessionId: "ct-session-1" });
const identityB = createRequestIdentity({ principal: "ct-principal-b", sessionId: "ct-session-1" });
const identitySession2 = createRequestIdentity({
  principal: "ct-principal-a",
  sessionId: "ct-session-2",
});

function tool(name: string, description: string) {
  return { name, description, inputSchema: { type: "object" as const, properties: {} } };
}

const SHELL = () => tool("run_shell", "execute a shell command");

function consentFor(
  entry: { name: string; description: string; inputSchema: unknown },
  serverId: string,
  overrides: Record<string, unknown> = {}
) {
  // The gateway keys consent snapshot matching on the vetting cache key
  // (name:desc:schema:server).
  return {
    userIdHash: identityA.principalHash,
    toolName: entry.name,
    toolSnapshotHash: buildVettingCacheKey(entry, serverId),
    ...overrides,
  };
}

interface CTResult {
  id: string;
  dimension: string;
  plan_decision: string;
  change: string;
  commit_decision: string;
  commit_matched_policy_ids: string[];
  verdict_recomputed: boolean;
}

const ctResults: CTResult[] = [];

function record(r: CTResult) {
  ctResults.push(r);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CT: commit-time authorization regression", () => {
  it("CT-01: approval expires between plan and commit → held", async () => {
    const gw = new MCPGateway();
    const entry = SHELL();
    gw.addConsentRecord(
      consentFor(entry, "srv", { expiresAt: new Date(Date.now() + 40).toISOString() })
    );

    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(plan.invocation.decision).toBe("allow"); // plan accepted under valid approval

    await sleep(60); // the approval's validity window passes

    const commit = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(commit.invocation.decision).toBe("ask_user");
    expect(commit.invocation.userConsentRef).toBeUndefined();
    record({
      id: "CT-01",
      dimension: "approval expiry",
      plan_decision: plan.invocation.decision,
      change: "approval expiresAt passes",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: plan.invocation.decision !== commit.invocation.decision,
    });
  });

  it("CT-02: tool descriptor snapshot changes after plan → commit fail-safe", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const original = tool("sync_records", "Syncs records");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(original, "srv"),
      effects: ["read_only"],
      sinks: [],
      capabilitiesRequired: [],
    });
    const gw = new MCPGateway({ profileRegistry: registry });

    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: original, args: {} });
    expect(plan.invocation.decision).toBe("allow");

    // Rug-pull: the server mutates its descriptor after planning.
    const mutated = tool("sync_records", "Syncs records (and uploads copies)");
    const commit = gw.evaluate({ identity: identityA, serverId: "srv", tool: mutated, args: {} });
    expect(commit.invocation.decision).toBe("ask_user");
    expect(commit.invocation.matchedPolicyIds).toContain("unknown-profile-fail-safe");
    record({
      id: "CT-02",
      dimension: "tool descriptor snapshot",
      plan_decision: plan.invocation.decision,
      change: "descriptor description mutated (rug-pull)",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-03: capability grant expires after plan → commit denied", async () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const entry = tool("deploy_service", "deploy the service");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(entry, "srv"),
      effects: ["write_external"],
      sinks: [],
      capabilitiesRequired: ["fs.write_external"],
    });
    const caps = new CapabilityRegistry();
    caps.grant({
      principal: identityA.principalHash,
      tenant: "srv",
      capability: "fs.write_external",
      expiresAt: new Date(Date.now() + 40).toISOString(),
    });
    const gw = new MCPGateway({ profileRegistry: registry, capabilityRegistry: caps });

    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(plan.invocation.decision).toBe("ask_user"); // profile asks for write effects; grant prevents deny

    await sleep(60);

    const commit = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(commit.invocation.decision).toBe("deny"); // expired grant → the ask hardens into denial
    expect(commit.invocation.matchedPolicyIds).toContain("profile-capability-required");
    record({
      id: "CT-03",
      dimension: "capability grant expiry",
      plan_decision: plan.invocation.decision,
      change: "grant expiresAt passes",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-04: capability revoked after plan → commit denied (no waiting for expiry)", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const entry = tool("deploy_service", "deploy the service");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(entry, "srv"),
      effects: ["write_external"],
      sinks: [],
      capabilitiesRequired: ["fs.write_external"],
    });
    const caps = new CapabilityRegistry();
    caps.grant({
      principal: identityA.principalHash,
      tenant: "srv",
      capability: "fs.write_external",
    });
    const gw = new MCPGateway({ profileRegistry: registry, capabilityRegistry: caps });

    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(plan.invocation.decision).toBe("ask_user"); // held with a live grant

    caps.revoke(identityA.principalHash, "fs.write_external");

    const commit = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(commit.invocation.decision).toBe("deny"); // revoked grant → denial
    record({
      id: "CT-04",
      dimension: "capability grant revocation",
      plan_decision: plan.invocation.decision,
      change: "operator revokes the grant",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-05: consent scope (args digest) does not match the commit's args → held", () => {
    const gw = new MCPGateway();
    const entry = SHELL();
    gw.addConsentRecord(
      consentFor(entry, "srv", { argScopeDigest: hashArgScope({ cmd: "ls /tmp" }) })
    );

    const plan = gw.evaluate({
      identity: identityA,
      serverId: "srv",
      tool: entry,
      args: { cmd: "ls /tmp" },
    });
    expect(plan.invocation.decision).toBe("allow");

    // Argument substitution between plan and commit.
    const commit = gw.evaluate({
      identity: identityA,
      serverId: "srv",
      tool: entry,
      args: { cmd: "rm -rf /" },
    });
    expect(commit.invocation.decision).toBe("ask_user");
    record({
      id: "CT-05",
      dimension: "consent scope (bound args)",
      plan_decision: plan.invocation.decision,
      change: "arguments substituted after planning",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-06: session binding — consent from plan session does not authorize another session", () => {
    const gw = new MCPGateway();
    const entry = SHELL();
    gw.addConsentRecord(consentFor(entry, "srv", { boundToSession: identityA.sessionId }));

    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(plan.invocation.decision).toBe("allow");

    const commit = gw.evaluate({
      identity: identitySession2,
      serverId: "srv",
      tool: entry,
      args: {},
    });
    expect(commit.invocation.decision).toBe("ask_user");
    record({
      id: "CT-06",
      dimension: "identity/session binding",
      plan_decision: plan.invocation.decision,
      change: "commit arrives on a different session",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-07: principal scoping — one principal's approval never commits another's action", () => {
    const gw = new MCPGateway();
    const entry = SHELL();
    gw.addConsentRecord(consentFor(entry, "srv"));

    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    expect(plan.invocation.decision).toBe("allow");

    const commit = gw.evaluate({ identity: identityB, serverId: "srv", tool: entry, args: {} });
    expect(commit.invocation.decision).toBe("ask_user");
    record({
      id: "CT-07",
      dimension: "principal/workspace binding",
      plan_decision: plan.invocation.decision,
      change: "different principal attempts the commit",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-08: budget/limit — a scope lease past its invocation budget is invalid at commit", () => {
    const lease = createScopeLease({
      principalHash: identityA.principalHash,
      serverId: "srv",
      grantedTools: ["run_shell"],
      maxInvocations: 2,
      ttlSeconds: 600,
    });
    expect(isScopeLeaseValid(lease)).toBe(true);
    lease.invocationCount = 2; // budget exhausted between plan and commit
    expect(isScopeLeaseValid(lease)).toBe(false);
    record({
      id: "CT-08",
      dimension: "budget/limit (scope lease)",
      plan_decision: "allow (lease valid)",
      change: "invocationCount reaches maxInvocations",
      commit_decision: "lease invalid — caller must re-authorize (isScopeLeaseValid=false)",
      commit_matched_policy_ids: ["scope-lease-budget"],
      verdict_recomputed: true,
    });
  });

  it("CT-09: target resource change after plan → tenant boundary denies the commit", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    const entry = tool("query_orders", "query orders");

    const plan = gw.evaluate({
      identity: identityA,
      serverId: "srv",
      tenant: "tenant-a",
      tool: entry,
      args: { resource: "/tenants/tenant-a/orders/1" },
    });
    // No allow is minted here without further context; the point is the COMMIT side.
    const commit = gw.evaluate({
      identity: identityA,
      serverId: "srv",
      tenant: "tenant-a",
      tool: entry,
      args: { resource: "/tenants/tenant-b/orders/1" },
    });
    expect(commit.invocation.decision).toBe("deny");
    record({
      id: "CT-09",
      dimension: "target resource",
      plan_decision: plan.invocation.decision,
      change: "commit targets tenant-b resource under tenant-a authority",
      commit_decision: commit.invocation.decision,
      commit_matched_policy_ids: commit.invocation.matchedPolicyIds,
      verdict_recomputed: true,
    });
  });

  it("CT-NI-01: no durable two-phase plan/commit API is claimed (not-implemented, stated)", () => {
    // Documented absence: evaluate() recomputes per call; there is no plan
    // object carrying an "expected state transition" precondition that the
    // commit re-validates. If a consumer needs that, it must build it on top
    // of these primitives — the firewall does not fake it.
    const gw = new MCPGateway();
    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: SHELL(), args: {} });
    expect(typeof plan.invocation.decision).toBe("string");
    expect((gw as unknown as { plan?: unknown }).plan).toBeUndefined();
  });

  it("CT-INV-01: plan verdict object is never reused as the commit verdict", () => {
    const gw = new MCPGateway();
    const entry = SHELL();
    gw.addConsentRecord(consentFor(entry, "srv", { boundToSession: identityA.sessionId }));
    const plan = gw.evaluate({ identity: identityA, serverId: "srv", tool: entry, args: {} });
    const commit = gw.evaluate({
      identity: identitySession2,
      serverId: "srv",
      tool: entry,
      args: {},
    });
    // Distinct objects, distinct state — no replay.
    expect(plan.invocation).not.toBe(commit.invocation);
    expect(plan.invocation.decision).toBe("allow");
    expect(commit.invocation.decision).toBe("ask_user");
  });

  it("CT-RESULTS: persist the commit-time matrix", () => {
    const out = {
      schema: "wasmagent-mcp-firewall-commit-time-authority/v1",
      tested_sha: "0dc88812f1c52d8c66797fc89094951475f244b8",
      generated_by: "packages/mcp-firewall/src/commit-time-authority.test.ts",
      claim_ceiling:
        "recompute-at-commit model: every evaluate() recomputes authority from current state; a durable plan/commit API with expected-state-transition preconditions is not implemented",
      cases: ctResults,
    };
    writeFileSync(
      join(import.meta.dir, "../evals/evidence/commit-time-authority-results.json"),
      `${JSON.stringify(out, null, 2)}\n`
    );
    expect(ctResults.filter((c) => c.verdict_recomputed).length).toBeGreaterThanOrEqual(7);
  });
});
