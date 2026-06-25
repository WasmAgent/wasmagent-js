import { describe, expect, it } from "bun:test";
import { buildServerCard } from "@wasmagent/mcp-firewall";
import { AttestationRegistry, buildAttestation } from "./attestation.js";

const CARD = buildServerCard({
  serverId: "srv1",
  tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
  operatorVerified: true,
});

describe("buildAttestation", () => {
  it("produces attestation with 16-char id", () => {
    const att = buildAttestation({
      card: CARD,
      level: "operator",
      capabilities: ["read"],
      attestedBy: "ops-team",
    });
    expect(att.attestationId).toHaveLength(16);
    expect(att.serverId).toBe("srv1");
    expect(att.level).toBe("operator");
  });
});

describe("AttestationRegistry", () => {
  it("lookupByServer returns registered attestations", () => {
    const reg = new AttestationRegistry();
    const att = buildAttestation({
      card: CARD,
      level: "community",
      capabilities: ["read", "write"],
      attestedBy: "community",
    });
    reg.register(att);
    expect(reg.lookupByServer("srv1")).toHaveLength(1);
    expect(reg.hasAttestation("srv1", "community")).toBe(true);
    expect(reg.hasAttestation("srv1", "audited")).toBe(false);
  });
});
