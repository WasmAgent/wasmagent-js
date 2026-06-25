/**
 * AuditLogger — pluggable audit log for MCPGateway decisions.
 */
import type { GatewayDecision, GatewayRequest } from "@wasmagent/mcp-firewall";

export interface AuditEvent {
  eventId: string;
  timestampMs: number;
  principalHash: string;
  sessionId: string;
  serverId: string;
  toolName: string;
  decision: string;
  stateChanging: boolean;
  policyDecision: string;
  toolManifestDigest?: string;
}

export interface AuditLogger {
  log(event: AuditEvent): void | Promise<void>;
}

export function buildAuditEvent(
  req: GatewayRequest,
  decision: GatewayDecision,
  eventId: string,
  timestampMs: number
): AuditEvent {
  return {
    eventId,
    timestampMs,
    principalHash: req.identity.principalHash,
    sessionId: req.identity.sessionId,
    serverId: req.serverId,
    toolName: req.tool.name,
    decision: decision.invocation.decision,
    stateChanging: decision.stateChanging,
    policyDecision: decision.evidenceRef.policyDecision,
    ...(decision.evidenceRef.toolManifestDigest !== undefined
      ? { toolManifestDigest: decision.evidenceRef.toolManifestDigest }
      : {}),
  };
}

export class InMemoryAuditLogger implements AuditLogger {
  readonly #events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.#events.push(event);
  }

  all(): AuditEvent[] {
    return [...this.#events];
  }
  denied(): AuditEvent[] {
    return this.#events.filter((e) => e.policyDecision === "deny");
  }
  stateChanging(): AuditEvent[] {
    return this.#events.filter((e) => e.stateChanging);
  }
}
