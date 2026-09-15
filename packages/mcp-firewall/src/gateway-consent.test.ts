/**
 * GW-CONSENT-01..08 — the ACTUAL MCPGateway consent path uses the
 * omission-safe argument-scope / session-bound consent model (final-audit C1).
 *
 * Previously the gateway stored the narrow `ConsentRecord` from policy.ts,
 * so consent reused across changed arguments and sessions. Now:
 * - stored argScopeDigest present → the CURRENT call's args must match
 * - stored boundToSession present → the CURRENT call's session must match
 * - omission of a binding on the stored side keeps documented broad behavior
 *
 * Ledger-level omission safety is covered by CONSENT-ADV-06..11 in
 * consent-hardening.test.ts; this file proves the gateway integration.
 */

import { describe, expect, it } from "bun:test";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import { hashArgScope } from "./consent.js";
import { createRequestIdentity, MCPGateway } from "./gateway.js";
import { buildVettingCacheKey } from "./vetting.js";

function highRiskTool(): McpToolEntry {
  return {
    name: "deploy_prod",
    // exfiltration keyword makes vetTool emit a high finding → ask_user
    // baseline for every caller.
    description: "Deploys the service and reads the deployment secret from env",
    inputSchema: { type: "object", properties: {} },
  };
}

const TOOL = highRiskTool();

function makeGatewayWithConsent(consent: {
  argScopeDigest?: string;
  boundToSession?: string;
}): MCPGateway {
  const gw = new MCPGateway();
  gw.addConsentRecord({
    toolName: "deploy_prod",
    userIdHash: createRequestIdentity({ principal: "alice", sessionId: "sA" }).principalHash,
    toolSnapshotHash: buildVettingCacheKey(TOOL, "srv"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(consent.argScopeDigest !== undefined ? { argScopeDigest: consent.argScopeDigest } : {}),
    ...(consent.boundToSession !== undefined ? { boundToSession: consent.boundToSession } : {}),
  });
  return gw;
}

const ARGS = { path: "/srv/app", version: "v2" };

describe("GW-CONSENT: gateway consent is argument-scope and session bound (C1)", () => {
  it("GW-CONSENT-01: exact args + same session → consent valid (allow)", () => {
    const gw = makeGatewayWithConsent({
      argScopeDigest: hashArgScope(ARGS),
      boundToSession: "sA",
    });
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "alice", sessionId: "sA" }),
      serverId: "srv",
      tool: TOOL,
      args: { ...ARGS },
    });
    expect(d.invocation.decision).toBe("allow");
  });

  it("GW-CONSENT-02: changed args → ask_user remains", () => {
    const gw = makeGatewayWithConsent({
      argScopeDigest: hashArgScope(ARGS),
      boundToSession: "sA",
    });
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "alice", sessionId: "sA" }),
      serverId: "srv",
      tool: TOOL,
      args: { path: "/srv/OTHER", version: "v2" },
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("GW-CONSENT-03: changed session → ask_user remains", () => {
    const gw = makeGatewayWithConsent({
      argScopeDigest: hashArgScope(ARGS),
      boundToSession: "sA",
    });
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "alice", sessionId: "sB" }),
      serverId: "srv",
      tool: TOOL,
      args: { ...ARGS },
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("GW-CONSENT-04: stored scoped consent cannot be satisfied by an empty-args call (digest mismatch → fail closed)", () => {
    const gw = makeGatewayWithConsent({ argScopeDigest: hashArgScope(ARGS) });
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "alice", sessionId: "sA" }),
      serverId: "srv",
      tool: TOOL,
      args: {},
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("GW-CONSENT-05: session-bound consent never matches a different session (fail closed)", () => {
    const gw = makeGatewayWithConsent({ boundToSession: "sA" });
    for (const session of ["sB", "sC"]) {
      const d = gw.evaluate({
        identity: createRequestIdentity({ principal: "alice", sessionId: session }),
        serverId: "srv",
        tool: TOOL,
        args: { ...ARGS },
      });
      expect(d.invocation.decision).toBe("ask_user");
    }
  });

  it("GW-CONSENT-06: descriptor change invalidates gateway consent (rug-pull)", () => {
    const gw = makeGatewayWithConsent({
      argScopeDigest: hashArgScope(ARGS),
      boundToSession: "sA",
    });
    const drifted = { ...TOOL, description: `${TOOL.description} Now also syncs to cloud.` };
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "alice", sessionId: "sA" }),
      serverId: "srv",
      tool: drifted,
      args: { ...ARGS },
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("GW-CONSENT-07: principal change invalidates gateway consent", () => {
    const gw = makeGatewayWithConsent({
      argScopeDigest: hashArgScope(ARGS),
      boundToSession: "sA",
    });
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "mallory", sessionId: "sA" }),
      serverId: "srv",
      tool: TOOL,
      args: { ...ARGS },
    });
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("GW-CONSENT-08: legacy broad consent (no digest/session) keeps documented compatibility behavior", () => {
    const gw = makeGatewayWithConsent({});
    // Any args, any session, same principal + descriptor → still honored.
    for (const args of [{ ...ARGS }, {}, { path: "/elsewhere" }]) {
      const d = gw.evaluate({
        identity: createRequestIdentity({ principal: "alice", sessionId: "sX" }),
        serverId: "srv",
        tool: TOOL,
        args,
      });
      expect(d.invocation.decision).toBe("allow");
    }
  });

  it("GW-CONSENT-09: arg-scope digest is order-independent at the gateway", () => {
    const gw = makeGatewayWithConsent({ argScopeDigest: hashArgScope(ARGS) });
    const reordered = { version: "v2", path: "/srv/app" };
    const d = gw.evaluate({
      identity: createRequestIdentity({ principal: "alice", sessionId: "sA" }),
      serverId: "srv",
      tool: TOOL,
      args: reordered,
    });
    expect(d.invocation.decision).toBe("allow");
  });
});
