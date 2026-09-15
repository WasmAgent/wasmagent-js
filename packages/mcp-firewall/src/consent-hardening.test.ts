/**
 * FW-08: Consent hardening tests — argument scope digest + anti-replay.
 *
 * Verifies that argScopeDigest correctly restricts consent to specific argument
 * values, boundToSession prevents cross-session replay, and backward compatibility
 * is maintained when neither field is present.
 */

import { describe, expect, test } from "bun:test";
import type { ConsentCacheKey, ConsentEvent } from "./consent.js";
import { hashArgScope, InMemoryConsentLedger } from "./consent.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  opts: {
    argScopeDigest?: string;
    boundToSession?: string;
    expiresAt?: string;
    toolSnapshotHash?: string;
  } = {}
): ConsentEvent {
  return {
    userIdHash: "user-abc",
    action: "approve_call",
    toolName: "create_file",
    scope: [],
    toolSnapshotHash: opts.toolSnapshotHash ?? "snap-v1",
    descriptionHash: "desc-abc",
    inputSchemaHash: "schema-abc",
    serverIdentity: "server-abc",
    uiTextHash: "ui-abc",
    recordedAt: new Date().toISOString(),
    ...(opts.argScopeDigest !== undefined ? { argScopeDigest: opts.argScopeDigest } : {}),
    ...(opts.boundToSession !== undefined ? { boundToSession: opts.boundToSession } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
}

function makeKey(
  opts: {
    argScopeDigest?: string;
    sessionId?: string;
    toolSnapshotHash?: string;
  } = {}
): ConsentCacheKey {
  return {
    name: "create_file",
    descriptionHash: "desc-abc",
    inputSchemaHash: "schema-abc",
    serverIdentity: "server-abc",
    toolSnapshotHash: opts.toolSnapshotHash ?? "snap-v1",
    ...(opts.argScopeDigest !== undefined ? { argScopeDigest: opts.argScopeDigest } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("consent hardening", () => {
  // CONSENT-ADV-01
  test("consent with argScopeDigest is invalid for different args", () => {
    const ledger = new InMemoryConsentLedger();
    ledger.record(makeEvent({ argScopeDigest: hashArgScope({ path: "/tmp/a.txt" }) }));

    const found = ledger.hasConsent(
      makeKey({ argScopeDigest: hashArgScope({ path: "/etc/passwd" }) })
    );
    expect(found).toBe(false);
  });

  // CONSENT-ADV-02
  test("consent with argScopeDigest is valid for same args", () => {
    const ledger = new InMemoryConsentLedger();
    const digest = hashArgScope({ path: "/tmp/a.txt" });
    ledger.record(makeEvent({ argScopeDigest: digest }));

    const found = ledger.hasConsent(makeKey({ argScopeDigest: digest }));
    expect(found).toBe(true);
  });

  // CONSENT-ADV-03
  test("consent without argScopeDigest matches any args (backward compat)", () => {
    const ledger = new InMemoryConsentLedger();
    // Event recorded without an argScopeDigest (old behavior)
    ledger.record(makeEvent());

    // Lookup with an argScopeDigest — should still find the broad consent
    const found = ledger.hasConsent(makeKey({ argScopeDigest: hashArgScope({ path: "/sensitive" }) }));
    expect(found).toBe(true);
  });

  // CONSENT-ADV-04
  test("consent with boundToSession is invalid in a different session", () => {
    const ledger = new InMemoryConsentLedger();
    ledger.record(makeEvent({ boundToSession: "sess-A" }));

    const found = ledger.hasConsent(makeKey({ sessionId: "sess-B" }));
    expect(found).toBe(false);
  });

  // CONSENT-ADV-05
  test("consent with boundToSession is valid in the same session", () => {
    const ledger = new InMemoryConsentLedger();
    ledger.record(makeEvent({ boundToSession: "sess-A" }));

    const found = ledger.hasConsent(makeKey({ sessionId: "sess-A" }));
    expect(found).toBe(true);
  });

  // CONSENT-ADV-06
  test("hashArgScope produces identical digests regardless of key insertion order", () => {
    const d1 = hashArgScope({ a: 1, b: 2 });
    const d2 = hashArgScope({ b: 2, a: 1 });
    expect(d1).toBe(d2);
  });

  // CONSENT-ADV-07
  test("expired consent is always invalid", () => {
    const ledger = new InMemoryConsentLedger();
    const pastExpiry = new Date(Date.now() - 2000).toISOString();
    ledger.record(makeEvent({ expiresAt: pastExpiry }));

    expect(ledger.hasConsent(makeKey())).toBe(false);
  });

  // CONSENT-ADV-08
  test("consent is invalid after descriptor change (toolSnapshotHash mismatch)", () => {
    const ledger = new InMemoryConsentLedger();
    ledger.record(makeEvent({ toolSnapshotHash: "snap-original" }));

    const found = ledger.hasConsent(makeKey({ toolSnapshotHash: "snap-modified" }));
    expect(found).toBe(false);
  });
});
