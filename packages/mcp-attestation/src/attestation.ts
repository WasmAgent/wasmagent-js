/**
 * MCPAttestation — capability attestation for MCP servers.
 *
 * An attestation is a signed claim that a server has been reviewed
 * and its tools are considered safe for a given capability scope.
 * This is the simplest possible form: a hash + metadata record.
 * Full PKI signing can be layered on top via Sigstore.
 */
import { createHash } from "node:crypto";
import type { ServerCard } from "@wasmagent/mcp-firewall";

export type AttestationLevel = "self" | "community" | "operator" | "audited";

export interface CapabilityAttestation {
  attestationId: string;
  serverId: string;
  toolManifestDigest: string;
  level: AttestationLevel;
  capabilities: string[];
  attestedBy: string;
  attestedAt: string;
  expiresAt?: string;
  notes?: string;
}

export function buildAttestation(opts: {
  card: ServerCard;
  level: AttestationLevel;
  capabilities: string[];
  attestedBy: string;
  expiresAt?: string;
  notes?: string;
}): CapabilityAttestation {
  const id = createHash("sha256")
    .update(opts.card.serverId + opts.card.toolManifestDigest + opts.attestedBy)
    .digest("hex")
    .slice(0, 16);
  return {
    attestationId: id,
    serverId: opts.card.serverId,
    toolManifestDigest: opts.card.toolManifestDigest,
    level: opts.level,
    capabilities: opts.capabilities,
    attestedBy: opts.attestedBy,
    attestedAt: new Date().toISOString(),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
  };
}

export function isAttestationValid(att: CapabilityAttestation): boolean {
  if (!att.expiresAt) return true;
  return new Date(att.expiresAt) > new Date();
}

export class AttestationRegistry {
  readonly #store = new Map<string, CapabilityAttestation>();

  register(att: CapabilityAttestation): void {
    this.#store.set(att.attestationId, att);
  }

  lookupByServer(serverId: string): CapabilityAttestation[] {
    return [...this.#store.values()].filter(
      (a) => a.serverId === serverId && isAttestationValid(a)
    );
  }

  hasAttestation(serverId: string, level: AttestationLevel): boolean {
    const LEVELS: AttestationLevel[] = ["self", "community", "operator", "audited"];
    const minIdx = LEVELS.indexOf(level);
    return this.lookupByServer(serverId).some((a) => LEVELS.indexOf(a.level) >= minIdx);
  }
}
