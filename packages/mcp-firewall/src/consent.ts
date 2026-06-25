/**
 * Consent ledger — record and query user approvals for high-risk tool calls.
 *
 * All approvals are scoped to a tool snapshot hash, so a rug-pull
 * automatically invalidates prior consent.
 */

import { createHash } from "node:crypto";

export type ConsentAction =
  | "approve_tool"
  | "approve_call"
  | "approve_sampling";

export interface ConsentEvent {
  userIdHash: string;
  action: ConsentAction;
  toolName: string;
  scope: string[];
  expiresAt?: string;      // ISO-8601
  /** Hash of the ToolDescriptorSnapshot at consent time — ties consent to exact descriptor. */
  toolSnapshotHash: string;
  /** Hash of the UI text shown to the user when they approved. */
  uiTextHash: string;
  recordedAt: string;      // ISO-8601
}

export interface ConsentLedger {
  record(event: ConsentEvent): void;
  hasConsent(toolName: string, toolSnapshotHash: string): boolean;
  getConsents(toolName: string): ConsentEvent[];
  revoke(toolName: string): void;
  all(): ConsentEvent[];
}

export function hashUiText(uiText: string): string {
  return createHash("sha256").update(uiText, "utf8").digest("hex").slice(0, 16);
}

/** In-memory consent ledger. For production use, back with KV or a DB. */
export class InMemoryConsentLedger implements ConsentLedger {
  private readonly _events: ConsentEvent[] = [];

  record(event: ConsentEvent): void {
    this._events.push(event);
  }

  hasConsent(toolName: string, toolSnapshotHash: string): boolean {
    const now = new Date();
    return this._events.some(
      (e) =>
        e.toolName === toolName &&
        e.toolSnapshotHash === toolSnapshotHash &&
        (!e.expiresAt || new Date(e.expiresAt) > now),
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
