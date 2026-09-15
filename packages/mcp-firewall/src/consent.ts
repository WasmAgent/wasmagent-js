/**
 * Consent ledger — record and query user approvals for high-risk tool calls.
 *
 * All approvals are scoped to a composite cache key that includes the tool name,
 * description hash, inputSchema hash, serverIdentity, and toolSnapshotHash.
 * Any change to the tool descriptor automatically invalidates prior consent,
 * preventing rug-pull attacks where a tool's definition changes after approval.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./gateway.js";

export type ConsentAction = "approve_tool" | "approve_call" | "approve_sampling";

export interface ConsentEvent {
  userIdHash: string;
  action: ConsentAction;
  toolName: string;
  scope: string[];
  expiresAt?: string; // ISO-8601
  /** Hash of the ToolDescriptorSnapshot at consent time — ties consent to exact descriptor. */
  toolSnapshotHash: string;
  /** SHA-256 (first 16 hex) of the tool description at consent time. */
  descriptionHash: string;
  /** SHA-256 (first 16 hex) of JSON.stringify(inputSchema) at consent time. */
  inputSchemaHash: string;
  /** Identity of the server that provides this tool (e.g. serverId). */
  serverIdentity: string;
  /** Hash of the UI text shown to the user when they approved. */
  uiTextHash: string;
  recordedAt: string; // ISO-8601
  /** SHA-256 (first 16 hex) of the approved argument scope. Absent = any args. */
  argScopeDigest?: string;
  /** Session identifier — when set, consent is only valid within this session (anti-replay). */
  boundToSession?: string;
}

/**
 * Composite key parameters for consent lookup.
 * Using all five fields ensures that any mutation of the tool descriptor
 * (description, schema, server, or snapshot hash) causes a cache miss.
 */
export interface ConsentCacheKey {
  name: string;
  descriptionHash: string;
  inputSchemaHash: string;
  serverIdentity: string;
  toolSnapshotHash: string;
  /** When present, consent must have a matching argScopeDigest (both must be set). */
  argScopeDigest?: string;
  /** When present, consent with boundToSession must match this sessionId. */
  sessionId?: string;
}

export interface ConsentLedger {
  record(event: ConsentEvent): void;
  /**
   * Check whether valid (non-expired) consent exists for the given composite key.
   * All five fields must match the recorded consent exactly.
   */
  hasConsent(key: ConsentCacheKey): boolean;
  /**
   * @deprecated Use hasConsent(ConsentCacheKey) with full composite key.
   *   This overload only matches on name + toolSnapshotHash and ignores
   *   description/schema/serverIdentity changes — prefer the full-key variant.
   */
  hasConsentLegacy(toolName: string, toolSnapshotHash: string): boolean;
  getConsents(toolName: string): ConsentEvent[];
  revoke(toolName: string): void;
  all(): ConsentEvent[];
}

export function hashUiText(uiText: string): string {
  return createHash("sha256").update(uiText, "utf8").digest("hex").slice(0, 16);
}

export function hashField(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * Compute a stable, order-independent digest of a tool call's argument scope.
 * Uses deterministic JSON serialisation so `{a:1,b:2}` and `{b:2,a:1}` produce
 * the same digest.
 */
export function hashArgScope(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 16);
}

/** In-memory consent ledger. For production use, back with KV or a DB. */
export class InMemoryConsentLedger implements ConsentLedger {
  private readonly _events: ConsentEvent[] = [];

  record(event: ConsentEvent): void {
    this._events.push(event);
  }

  /**
   * Check consent using the full composite cache key.
   * All five core fields (name, descriptionHash, inputSchemaHash, serverIdentity,
   * toolSnapshotHash) must match — any single change causes a miss.
   *
   * Optional hardening:
   * - argScopeDigest: if BOTH the stored event and the key have it, they must match.
   * - boundToSession / sessionId: if the stored event has boundToSession and the
   *   key provides sessionId, they must match (anti-replay across sessions).
   */
  hasConsent(key: ConsentCacheKey): boolean {
    const now = new Date();
    return this._events.some(
      (e) =>
        e.toolName === key.name &&
        e.descriptionHash === key.descriptionHash &&
        e.inputSchemaHash === key.inputSchemaHash &&
        e.serverIdentity === key.serverIdentity &&
        e.toolSnapshotHash === key.toolSnapshotHash &&
        (!e.expiresAt || new Date(e.expiresAt) > now) &&
        // argScopeDigest: only enforced when both sides carry a digest
        (e.argScopeDigest === undefined ||
          key.argScopeDigest === undefined ||
          e.argScopeDigest === key.argScopeDigest) &&
        // boundToSession: enforced when stored consent is session-bound and
        // caller provides a sessionId
        (e.boundToSession === undefined ||
          key.sessionId === undefined ||
          e.boundToSession === key.sessionId)
    );
  }

  /**
   * @deprecated Use hasConsent(ConsentCacheKey) with full composite key.
   *   This overload only matches on name + toolSnapshotHash and ignores
   *   description/schema/serverIdentity changes — prefer the full-key variant.
   */
  hasConsentLegacy(toolName: string, toolSnapshotHash: string): boolean {
    const now = new Date();
    return this._events.some(
      (e) =>
        e.toolName === toolName &&
        e.toolSnapshotHash === toolSnapshotHash &&
        (!e.expiresAt || new Date(e.expiresAt) > now)
    );
  }

  getConsents(toolName: string): ConsentEvent[] {
    return this._events.filter((e) => e.toolName === toolName);
  }

  revoke(toolName: string): void {
    const now = new Date().toISOString();
    for (const e of this._events) {
      if (e.toolName === toolName && !e.expiresAt) {
        e.expiresAt = now; // expire immediately
      }
    }
  }

  all(): ConsentEvent[] {
    return [...this._events];
  }
}
